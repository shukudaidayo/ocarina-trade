import { BrowserProvider, Contract, Interface, JsonRpcProvider, zeroPadValue, ZeroHash, parseUnits } from 'ethers'
import { Seaport } from '@opensea/seaport-js'
import { ItemType } from '@opensea/seaport-js/lib/constants'
import { CHAINS, SEAPORT_ADDRESS, ZONE_ADDRESSES, ZONE_DEPLOY_BLOCKS, ZONE_ABI, WHITELISTED_ERC20 } from './constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Retry an async function up to `n` times with a brief delay between attempts.
 * Only retries on network/RPC errors, not on application-level errors.
 */
async function retry(fn, n = 3, delayMs = 500) {
  for (let i = 0; i < n; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === n - 1) throw err
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
    }
  }
}

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
async function getSigner(rawProvider) {
  const provider = new BrowserProvider(rawProvider)
  return provider.getSigner()
}

/**
 * Get a Seaport SDK instance connected to a signer.
 */
async function getSeaport(rawProvider) {
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
  memo = '',
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

  const reg = {
    orderHash,
    maker: makerAddress,
    taker: takerAddress,
    offer: spentItems,
    consideration: receivedItems,
    signature: order.signature,
    orderURI,
    memo,
  }
  const tx = await zone.registerOrder(reg)

  return {
    order,
    orderHash,
    tx,
    wait: () => tx.wait(),
  }
}

/**
 * Verify an OrderRegistered event and extract authenticated fields.
 *
 * The OTCZone contract only binds `orderHash` + `maker` via signature — every
 * other event field (`taker`, `orderURI`, `memo`) is forgeable by anyone who
 * observed a maker's public signature. We re-anchor trust by recomputing the
 * Seaport order hash from the decoded orderURI: if it matches `orderHash`,
 * the decoded order is cryptographically the exact order the maker signed, so
 * `offerer`, `offer`, `consideration`, and `zoneHash` (→ taker) are safe to use.
 *
 * Returns null when verification fails — caller should skip the event.
 *
 * Residual risk: `memo` is not covered by any onchain hash and remains
 * unauthenticated. See SPEC-SEAPORT.md § Contract Upgrades for the deferred
 * contract-side fix (bind all registration fields into a typed EIP-712 digest).
 */
function verifyAndExtract(parsedOrLog, chainId) {
  const args = parsedOrLog.args
  let order
  try { order = JSON.parse(atob(args.orderURI)) } catch { return null }
  if (!order?.parameters) return null

  let computedHash
  try { computedHash = getReadSeaport(chainId).getOrderHash(order.parameters) }
  catch { return null }
  if (computedHash.toLowerCase() !== args.orderHash.toLowerCase()) return null

  // Derive taker from the decoded order's zoneHash — identical to the contract's
  // `address(uint160(uint256(zoneHash)))` cast. Ignore the event's taker field.
  const zoneHash = order.parameters.zoneHash || ZeroHash
  const taker = '0x' + zoneHash.slice(-40).toLowerCase()

  return {
    orderHash: args.orderHash,
    maker: order.parameters.offerer,
    taker,
    memo: args.memo || '',
    order,
  }
}

/**
 * Fetch order data from a registerOrder transaction hash.
 * Returns the parsed OrderRegistered event data + decoded signed order.
 */
export async function getOrderFromTx(chainId, txHash) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  return retry(async () => {
    const provider = new JsonRpcProvider(chain.rpcUrl)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!receipt) throw new Error('Transaction not found')

    const iface = new Interface(ZONE_ABI)
    for (const log of receipt.logs) {
      let parsed
      try { parsed = iface.parseLog(log) } catch { continue }
      if (parsed?.name !== 'OrderRegistered') continue
      const extracted = verifyAndExtract(parsed, chainId)
      if (!extracted) throw new Error('Order registration failed verification — the event does not match the signed order.')
      return { zoneAddress: receipt.to, ...extracted }
    }
    throw new Error('No OrderRegistered event found in transaction')
  })
}

/**
 * Get the on-chain status of a Seaport order.
 * Returns { isValidated, isCancelled, totalFilled, totalSize }
 */
// Cache read-only providers and Seaport instances per chain
const readProviders = {}
function getReadSeaport(chainId) {
  if (!readProviders[chainId]) {
    const chain = CHAINS[chainId]
    const provider = new JsonRpcProvider(chain.rpcUrl)
    readProviders[chainId] = new Seaport(provider)
  }
  return readProviders[chainId]
}

export async function getOrderStatus(chainId, orderHash) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  return retry(async () => {
    const seaport = getReadSeaport(chainId)
    return seaport.getOrderStatus(orderHash)
  })
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
 * Uses Blockscout API to get tx list, then fetches receipts via RPC.
 * Falls back to scanning recent blocks via RPC if Blockscout is unavailable.
 */
export async function queryOrderEvents(chainId, zoneAddress) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)

  let registrations = null
  if (chain.blockscoutApi) {
    try {
      registrations = await queryViaBlockscout(chainId, zoneAddress, chain)
    } catch (err) {
      console.warn('Blockscout query failed, falling back to RPC:', err.message)
    }
  }
  if (registrations === null) registrations = await queryViaRpc(chainId, zoneAddress, chain)

  return dedupeByOrderHash(registrations)
}

/**
 * Dedupe OrderRegistered events by orderHash, keeping the earliest registration
 * (lowest block, then lowest logIndex). Blocks replay-overwrite spoofing: the
 * legitimate maker's registration lands onchain before any attacker can observe
 * the signature, so first-seen wins rejects every forged duplicate.
 */
function dedupeByOrderHash(registrations) {
  const byHash = new Map()
  for (const r of registrations) {
    const existing = byHash.get(r.orderHash)
    if (!existing) { byHash.set(r.orderHash, r); continue }
    const earlier = r.blockNumber < existing.blockNumber
      || (r.blockNumber === existing.blockNumber && (r.logIndex ?? 0) < (existing.logIndex ?? 0))
    if (earlier) byHash.set(r.orderHash, r)
  }
  const deduped = Array.from(byHash.values())
  if (registrations._partial) deduped._partial = true
  return deduped
}

async function queryViaBlockscout(chainId, zoneAddress, chain) {
  const url = `${chain.blockscoutApi}?module=account&action=txlist&address=${zoneAddress}&startblock=0&endblock=99999999&sort=asc`
  const res = await fetch(url)
  if (!res.ok) return null

  const data = await res.json()
  if (data.status !== '1' || !Array.isArray(data.result)) {
    // status "0" with empty result means no transactions — that's valid
    if (data.message === 'No transactions found') return []
    return null
  }

  // Filter to successful txs only
  const txs = data.result.filter((tx) => tx.txreceipt_status === '1' || tx.isError === '0')
  if (txs.length === 0) return []

  // Fetch receipts and parse OrderRegistered events
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const iface = new Interface(ZONE_ABI)
  const BATCH = 5
  const registrations = []

  for (let i = 0; i < txs.length; i += BATCH) {
    const batch = txs.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async (tx) => {
        try {
          const receipt = await retry(() => provider.getTransactionReceipt(tx.hash))
          if (!receipt) return null
          for (const log of receipt.logs) {
            let parsed
            try { parsed = iface.parseLog(log) } catch { continue }
            if (parsed?.name !== 'OrderRegistered') continue
            const extracted = verifyAndExtract(parsed, chainId)
            if (!extracted) continue
            return {
              ...extracted,
              blockNumber: receipt.blockNumber,
              transactionHash: receipt.hash,
              logIndex: log.logIndex ?? log.index,
            }
          }
        } catch (err) {
          console.warn('Failed to fetch receipt for', tx.hash, err.message)
        }
        return null
      })
    )
    registrations.push(...results.filter(Boolean))
  }

  return registrations
}

async function queryViaRpc(chainId, zoneAddress, chain) {
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const zone = new Contract(zoneAddress, ZONE_ABI, provider)

  const latestBlock = await provider.getBlockNumber()
  // Scan last ~50k blocks as fallback (roughly 1-2 days on Polygon, 1 week on Ethereum)
  const fromBlock = Math.max(latestBlock - 49999, ZONE_DEPLOY_BLOCKS[chainId] ?? 0)

  const chunkSize = (chainId === 137 || chainId === 8453 || chainId === 57073) ? 9999 : 49999
  const ranges = []
  for (let start = fromBlock; start <= latestBlock; start += chunkSize + 1) {
    ranges.push([start, Math.min(start + chunkSize, latestBlock)])
  }

  const CONCURRENT = 3
  const logs = []
  for (let i = 0; i < ranges.length; i += CONCURRENT) {
    const batch = ranges.slice(i, i + CONCURRENT)
    const chunks = await Promise.all(
      batch.map(([start, end]) =>
        retry(() => zone.queryFilter('OrderRegistered', start, end))
      )
    )
    logs.push(...chunks.flat())
  }

  const registrations = logs.flatMap((log) => {
    const extracted = verifyAndExtract(log, chainId)
    if (!extracted) return []
    return [{
      ...extracted,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    }]
  })

  // Mark as partial so the UI can show a disclaimer
  registrations._partial = true
  return registrations
}

// keccak256('OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])')
// orderHash is NOT indexed — it's the first word of event data.
// Indexed topics: offerer (topic1), zone (topic2).
const ORDER_FULFILLED_TOPIC = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31'

/**
 * Find the transaction hash that fulfilled a Seaport order.
 * Queries Blockscout for OrderFulfilled events filtered by offerer + zone,
 * then matches orderHash from the event data.
 */
export async function getFillTxHash(chainId, orderHash, offerer) {
  const chain = CHAINS[chainId]
  if (!chain?.blockscoutApi) return null
  const zoneAddress = ZONE_ADDRESSES[chainId]
  if (!zoneAddress) return null

  try {
    const paddedOfferer = zeroPadValue(offerer, 32)
    const paddedZone = zeroPadValue(zoneAddress, 32)
    const url = `${chain.blockscoutApi}?module=logs&action=getLogs&address=${SEAPORT_ADDRESS}&topic0=${ORDER_FULFILLED_TOPIC}&topic1=${paddedOfferer}&topic2=${paddedZone}&topic0_1_opr=and&topic1_2_opr=and&topic0_2_opr=and&fromBlock=0&toBlock=latest`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (data.status !== '1' || !Array.isArray(data.result)) return null

    // orderHash is the first 32 bytes of event data
    const target = orderHash.toLowerCase()
    for (const log of data.result) {
      const dataHash = '0x' + log.data.slice(2, 66)
      if (dataHash === target) return log.transactionHash
    }
    return null
  } catch {
    return null
  }
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
