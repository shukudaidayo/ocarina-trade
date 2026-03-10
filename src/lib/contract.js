import { BrowserProvider, Contract, Interface, JsonRpcProvider, zeroPadValue, ZeroHash, parseUnits } from 'ethers'
import { Seaport } from '@opensea/seaport-js'
import { ItemType } from '@opensea/seaport-js/lib/constants'
import { CHAINS, SEAPORT_ADDRESS, ZONE_ADDRESSES, ZONE_DEPLOY_BLOCKS, ZONE_ABI, WHITELISTED_ERC20 } from './constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const APPROVAL_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]

const ERC20_APPROVE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]

/**
 * Get an ethers signer from a raw EIP-1193 provider.
 */
export async function getSigner(rawProvider) {
  const provider = new BrowserProvider(rawProvider)
  return provider.getSigner()
}

/**
 * Get a Seaport SDK instance connected to a signer.
 */
export async function getSeaport(rawProvider) {
  const signer = await getSigner(rawProvider)
  return new Seaport(signer)
}

/**
 * Ensure a token contract is approved for Seaport.
 * For ERC-721/ERC-1155: setApprovalForAll
 * For ERC-20: approve max amount
 */
export async function ensureApproval(rawProvider, tokenAddress, owner, itemType, amount) {
  const signer = await getSigner(rawProvider)

  if (itemType === ItemType.ERC20) {
    const token = new Contract(tokenAddress, ERC20_APPROVE_ABI, signer)
    const needed = amount ? BigInt(amount) : 2n ** 256n - 1n
    const allowance = await token.allowance(owner, SEAPORT_ADDRESS)
    if (allowance >= needed) return null
    const tx = await token.approve(SEAPORT_ADDRESS, needed)
    return tx
  }

  // ERC-721 or ERC-1155
  const token = new Contract(tokenAddress, APPROVAL_ABI, signer)
  const approved = await token.isApprovedForAll(owner, SEAPORT_ADDRESS)
  if (approved) return null
  const tx = await token.setApprovalForAll(SEAPORT_ADDRESS, true)
  return tx
}

/**
 * Convert our internal asset format to Seaport offer items.
 */
function toSeaportOfferItem(asset, chainId) {
  if (asset.assetType === 'NATIVE' || asset.itemType === ItemType.NATIVE) {
    return {
      amount: parseUnits(asset.amount || '0', 18).toString(),
    }
  }
  if (asset.assetType === 'ERC20' || asset.itemType === ItemType.ERC20) {
    const decimals = chainId ? (WHITELISTED_ERC20[chainId]?.[asset.token]?.decimals ?? 18) : 18
    return {
      token: asset.token,
      amount: parseUnits(asset.amount || '0', decimals).toString(),
    }
  }
  const seaportItemType = asset.assetType === 'ERC1155' || asset.itemType === ItemType.ERC1155
    ? ItemType.ERC1155
    : ItemType.ERC721

  const item = {
    itemType: seaportItemType,
    token: asset.token,
    identifier: asset.tokenId.toString(),
  }
  if (seaportItemType === ItemType.ERC1155) {
    item.amount = (asset.amount || '1').toString()
  }
  return item
}

/**
 * Convert our internal asset format to Seaport consideration items.
 */
function toSeaportConsiderationItem(asset, recipient, chainId) {
  return { ...toSeaportOfferItem(asset, chainId), recipient }
}

/**
 * Create a Seaport order: sign off-chain + register on OTCZone.
 * Returns { order, tx, wait } where tx is the registerOrder tx.
 */
export async function createOrder(rawProvider, chainId, {
  taker,
  makerAssets,
  takerAssets,
  expiration,
  makerAddress,
}) {
  const zoneAddress = ZONE_ADDRESSES[chainId]
  if (!zoneAddress) throw new Error(`No OTCZone deployed on chain ${chainId}`)

  const seaport = await getSeaport(rawProvider)

  const zoneHash = taker && taker !== ZERO_ADDRESS
    ? zeroPadValue(taker, 32)
    : ZeroHash

  const offer = makerAssets.map((a) => toSeaportOfferItem(a, chainId))
  const consideration = takerAssets.map((a) => toSeaportConsiderationItem(a, makerAddress, chainId))

  const endTime = expiration
    ? Math.floor(new Date(expiration).getTime() / 1000).toString()
    : Math.floor(Date.now() / 1000 + 30 * 24 * 60 * 60).toString()

  // Create and sign the order (no gas)
  const { executeAllActions } = await seaport.createOrder({
    zone: zoneAddress,
    zoneHash,
    offer,
    consideration,
    restrictedByZone: true,
    endTime,
  })

  const order = await executeAllActions()

  // Compute the order hash
  const orderHash = seaport.getOrderHash(order.parameters)

  // Encode the signed order as the orderURI
  const orderURI = btoa(JSON.stringify(order))

  // Register on OTCZone for discovery
  const signer = await getSigner(rawProvider)
  const zone = new Contract(zoneAddress, ZONE_ABI, signer)

  // Build SpentItem[] and ReceivedItem[] from the order parameters
  const spentItems = order.parameters.offer.map((o) => ({
    itemType: Number(o.itemType),
    token: o.token,
    identifier: BigInt(o.identifierOrCriteria),
    amount: BigInt(o.startAmount),
  }))

  const receivedItems = order.parameters.consideration.map((c) => ({
    itemType: Number(c.itemType),
    token: c.token,
    identifier: BigInt(c.identifierOrCriteria),
    amount: BigInt(c.startAmount),
    recipient: c.recipient,
  }))

  const takerAddress = taker && taker !== ZERO_ADDRESS ? taker : ZERO_ADDRESS

  const tx = await zone.registerOrder(orderHash, makerAddress, takerAddress, spentItems, receivedItems, order.signature, orderURI)

  return {
    order,
    orderHash,
    tx,
    wait: () => tx.wait(),
  }
}

/**
 * Fetch order data from a registerOrder transaction hash.
 * Returns the parsed OrderRegistered event data + decoded signed order.
 */
export async function getOrderFromTx(chainId, txHash) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) throw new Error('Transaction not found')

  const iface = new Interface(ZONE_ABI)
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log)
      if (parsed?.name === 'OrderRegistered') {
        const order = JSON.parse(atob(parsed.args.orderURI))
        return {
          zoneAddress: receipt.to,
          orderHash: parsed.args.orderHash,
          maker: parsed.args.maker,
          taker: parsed.args.taker,
          order, // The full signed Seaport order (OrderWithCounter)
        }
      }
    } catch {}
  }
  throw new Error('No OrderRegistered event found in transaction')
}

/**
 * Get the on-chain status of a Seaport order.
 * Returns { isValidated, isCancelled, totalFilled, totalSize }
 */
export async function getOrderStatus(chainId, orderHash) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const seaport = new Seaport(provider)
  return seaport.getOrderStatus(orderHash)
}

/**
 * Fulfill (accept) a Seaport order. Returns { tx, wait }.
 */
export async function fulfillOrder(rawProvider, order) {
  const seaport = await getSeaport(rawProvider)
  const { executeAllActions } = await seaport.fulfillOrder({ order })
  const tx = await executeAllActions()
  return { tx, wait: () => tx.wait() }
}

/**
 * Cancel a Seaport order. Returns { tx, wait }.
 */
export async function cancelOrder(rawProvider, orderComponents) {
  const seaport = await getSeaport(rawProvider)
  const tx = await seaport.cancelOrders([orderComponents]).transact()
  return { tx, wait: () => tx.wait() }
}

/**
 * Query all OrderRegistered events from the OTCZone contract.
 */
export async function queryOrderEvents(chainId, zoneAddress) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const zone = new Contract(zoneAddress, ZONE_ABI, provider)

  const fromBlock = ZONE_DEPLOY_BLOCKS[chainId] ?? 0
  const latestBlock = await provider.getBlockNumber()

  const chunkSize = 49999
  const logs = []
  for (let start = fromBlock; start <= latestBlock; start += chunkSize + 1) {
    const end = Math.min(start + chunkSize, latestBlock)
    const chunk = await zone.queryFilter('OrderRegistered', start, end)
    logs.push(...chunk)
  }

  const registrations = logs.map((log) => {
    let order = null
    try {
      order = JSON.parse(atob(log.args.orderURI))
    } catch {}
    return {
      orderHash: log.args.orderHash,
      maker: log.args.maker,
      taker: log.args.taker,
      order,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    }
  })

  return registrations
}

/**
 * Derive the status label for an order.
 */
export function deriveOrderStatus(seaportStatus, endTime) {
  if (!seaportStatus) return 'unknown'
  if (seaportStatus.isCancelled) return 'cancelled'
  if (seaportStatus.totalFilled > 0 && seaportStatus.totalFilled === seaportStatus.totalSize) return 'filled'
  if (endTime && Number(endTime) < Date.now() / 1000) return 'expired'
  return 'open'
}
