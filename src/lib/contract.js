import { BrowserProvider, Contract, Interface, JsonRpcProvider, zeroPadValue, ZeroHash, ZeroAddress, parseUnits } from 'ethers'
import { Seaport } from '@opensea/seaport-js'
import { ItemType, OrderType } from '@opensea/seaport-js/lib/constants'
import { CHAINS, SEAPORT_ADDRESS, ZONE_ADDRESSES, ZONE_DEPLOY_BLOCKS, ZONE_ABI, WHITELISTED_ERC20 } from './constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZONE_HASH_VERSION = 1n
const TAKER_MASK = (1n << 160n) - 1n
const COUNT_MASK = (1n << 32n) - 1n
const VERSION_MASK = (1n << 8n) - 1n

function encodeZoneHash(taker, originalConsiderationCount) {
  const takerValue = taker && taker !== ZERO_ADDRESS ? BigInt(taker) : 0n
  const count = BigInt(originalConsiderationCount)
  const packed = takerValue | (count << 160n) | (ZONE_HASH_VERSION << 192n)
  return `0x${packed.toString(16).padStart(64, '0')}`
}

function decodeZoneHash(zoneHash) {
  const packed = BigInt(zoneHash)
  return {
    taker: `0x${(packed & TAKER_MASK).toString(16).padStart(40, '0')}`,
    originalConsiderationCount: Number((packed >> 160n) & COUNT_MASK),
    version: Number((packed >> 192n) & VERSION_MASK),
    reserved: packed >> 200n,
  }
}

function zoneHashMatchesOrder(parameters, taker) {
  const metadata = decodeZoneHash(parameters.zoneHash)
  return metadata.version === Number(ZONE_HASH_VERSION) &&
    metadata.reserved === 0n &&
    metadata.originalConsiderationCount === parameters.consideration.length &&
    metadata.taker.toLowerCase() === taker.toLowerCase()
}

const SEAPORT_FULFILL_ABI = [
  'function fulfillOrder((tuple(address offerer,address zone,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,bytes signature) order,bytes32 fulfillerConduitKey) payable returns (bool fulfilled)',
  'function fulfillAdvancedOrder((tuple(address offerer,address zone,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,bytes signature,bytes extraData,uint120 numerator,uint120 denominator) advancedOrder,tuple(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns (bool fulfilled)',
]

// EIP-712 types for OTCRegistry.registerOrder. Mirrors the typehash in OTCRegistry.sol.
const REGISTRATION_TYPES = {
  OrderRegistration: [
    { name: 'orderHash', type: 'bytes32' },
    { name: 'seaportSignature', type: 'bytes' },
    { name: 'memo', type: 'string' },
  ],
}

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
  const isERC1155 = asset.assetType === 'ERC1155' || asset.itemType === ItemType.ERC1155 || asset.itemType === ItemType.ERC1155_WITH_CRITERIA
  const seaportItemType = isERC1155
    ? ItemType.ERC1155
    : ItemType.ERC721

  if (asset.criteria || asset.itemType === ItemType.ERC721_WITH_CRITERIA || asset.itemType === ItemType.ERC1155_WITH_CRITERIA) {
    const item = {
      itemType: seaportItemType,
      token: asset.token,
      criteria: asset.criteriaRoot || '0',
    }
    if (seaportItemType === ItemType.ERC1155) {
      item.amount = (asset.amount || '1').toString()
    }
    return item
  }

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
 * Create a Seaport order: sign off-chain + register on OTCRegistry.
 * Returns { order, tx, wait } where tx is the registerOrder tx.
 */
export async function createOrder(rawProvider, chainId, {
  taker,
  makerAssets,
  takerAssets,
  expiration,
  makerAddress,
  memo = '',
  onSeaportSigned,
  onRegistrationSigned,
}) {
  const zoneAddress = ZONE_ADDRESSES[chainId]
  if (!zoneAddress) throw new Error(`No OTCRegistry deployed on chain ${chainId}`)

  const seaport = await getSeaport(rawProvider)

  const offer = makerAssets.map((a) => toSeaportOfferItem(a, chainId))
  const consideration = takerAssets.map((a) => toSeaportConsiderationItem(a, makerAddress, chainId))
  const zoneHash = encodeZoneHash(taker, consideration.length)

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
  onSeaportSigned?.()

  // Compute the order hash (local seaport-js computation, matches onchain getOrderHash)
  const orderHash = seaport.getOrderHash(order.parameters)

  // Register on OTCRegistry for discovery
  const signer = await getSigner(rawProvider)
  const zoneContract = new Contract(zoneAddress, ZONE_ABI, signer)

  // Maker signs (orderHash, seaportSignature, memo) under OTCRegistry's EIP-712 domain.
  // orderHash transitively binds all OrderComponents fields (including offerer, taker via
  // zoneHash, and endTime). seaportSignature is bound directly to prevent a front-runner
  // from substituting a bad Seaport sig using this registration sig.
  const domain = {
    name: 'OTCRegistry',
    version: '1',
    chainId,
    verifyingContract: zoneAddress,
  }
  const regValue = {
    orderHash,
    seaportSignature: order.signature,
    memo,
  }
  const registrationSignature = await signer.signTypedData(domain, REGISTRATION_TYPES, regValue)
  onRegistrationSigned?.()

  const reg = {
    components: order.parameters,
    seaportSignature: order.signature,
    signature: registrationSignature,
    memo,
  }
  const tx = await zoneContract.registerOrder(reg)

  return {
    order,
    orderHash,
    tx,
    wait: () => tx.wait(),
  }
}

/**
 * Convert ABI-decoded OrderComponents (ethers Result with BigInt values) to the
 * plain-object format seaport-js expects for fulfillOrder and getOrderHash.
 */
function componentsFromEvent(c) {
  const consideration = Array.from(c.consideration).map((item) => ({
    itemType: Number(item.itemType),
    token: item.token,
    identifierOrCriteria: item.identifierOrCriteria.toString(),
    startAmount: item.startAmount.toString(),
    endAmount: item.endAmount.toString(),
    recipient: item.recipient,
  }))
  return {
    offerer: c.offerer,
    zone: c.zone,
    offer: Array.from(c.offer).map((item) => ({
      itemType: Number(item.itemType),
      token: item.token,
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
    })),
    consideration,
    orderType: Number(c.orderType),
    startTime: c.startTime.toString(),
    endTime: c.endTime.toString(),
    zoneHash: c.zoneHash,
    salt: c.salt.toString(),
    conduitKey: c.conduitKey,
    counter: c.counter.toString(),
    // seaport-js OrderComponents extends OrderParameters, which includes this field.
    // For a standard (non-criteria) order it equals consideration.length.
    totalOriginalConsiderationItems: consideration.length,
  }
}

/**
 * Decode an OrderRegistered event and recover the full Seaport order.
 *
 * The contract now verifies zone, orderType, taker/zoneHash alignment, and
 * derives orderHash via ISeaport.getOrderHash(components) before emitting —
 * so the event is trustworthy by construction. Registration pre-validates the
 * order hash in Seaport, so fulfillment uses an empty signature.
 */
function verifyAndExtract(parsedOrLog) {
  const args = parsedOrLog.args
  try {
    const order = {
      parameters: componentsFromEvent(args.components),
      signature: '0x',
    }
    if (!zoneHashMatchesOrder(order.parameters, args.taker)) return null

    return {
      orderHash: args.orderHash,
      maker: args.maker,
      taker: args.taker,
      memo: args.memo || '',
      order,
    }
  } catch {
    return null
  }
}

/**
 * Fetch order data from a registerOrder transaction hash.
 * Returns the parsed OrderRegistered event data + decoded validated order.
 */
export async function getOrderFromTx(chainId, txHash) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const zoneAddress = ZONE_ADDRESSES[chainId]
  if (!zoneAddress) throw new Error(`No OTCRegistry deployed on chain ${chainId}`)
  const expectedZone = zoneAddress.toLowerCase()

  return retry(async () => {
    const provider = new JsonRpcProvider(chain.rpcUrl)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!receipt) throw new Error('Transaction not found')

    const iface = new Interface(ZONE_ABI)
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== expectedZone) continue
      let parsed
      try { parsed = iface.parseLog(log) } catch { continue }
      if (parsed?.name !== 'OrderRegistered') continue
      const extracted = verifyAndExtract(parsed)
      if (!extracted) throw new Error('Order registration failed verification — the event does not match the signed order.')
      if (extracted.order.parameters.zone.toLowerCase() !== expectedZone) {
        throw new Error('Order registration failed verification — the order uses an unexpected zone.')
      }
      if (extracted.order.parameters.orderType !== OrderType.FULL_RESTRICTED) {
        throw new Error('Order registration failed verification — the order is not restricted by the registry.')
      }
      const derivedHash = getReadSeaport(chainId).getOrderHash(extracted.order.parameters)
      if (derivedHash.toLowerCase() !== extracted.orderHash.toLowerCase()) {
        throw new Error('Order registration failed verification — the event order hash does not match the decoded order.')
      }
      return { zoneAddress, ...extracted }
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

export async function getCounter(chainId, offerer) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  return retry(async () => {
    const seaport = getReadSeaport(chainId)
    return seaport.getCounter(offerer)
  })
}

/**
 * Fulfill (accept) a Seaport order. Returns { tx, wait }.
 */
function isCriteriaItem(item) {
  const itemType = Number(item.itemType)
  return itemType === ItemType.ERC721_WITH_CRITERIA || itemType === ItemType.ERC1155_WITH_CRITERIA
}

function buildCriteriaResolvers(order, criteriaSelections = {}) {
  const resolvers = []
  order.parameters.offer.forEach((item, index) => {
    if (!isCriteriaItem(item)) return
    const identifier = criteriaSelections.offer?.[index]
    if (!identifier && identifier !== '0') throw new Error('Choose a token ID for every criteria item before accepting this offer.')
    resolvers.push({ orderIndex: 0, side: 0, index, identifier: identifier.toString(), criteriaProof: [] })
  })
  order.parameters.consideration.forEach((item, index) => {
    if (!isCriteriaItem(item)) return
    const identifier = criteriaSelections.consideration?.[index]
    if (!identifier && identifier !== '0') throw new Error('Choose a token ID for every criteria item before accepting this offer.')
    resolvers.push({ orderIndex: 0, side: 1, index, identifier: identifier.toString(), criteriaProof: [] })
  })
  return resolvers
}

function nativeConsiderationValue(order) {
  return order.parameters.consideration.reduce((sum, item) => (
    Number(item.itemType) === ItemType.NATIVE ? sum + BigInt(item.startAmount) : sum
  ), 0n)
}

function advancedOrderFromOrder(order) {
  return {
    parameters: order.parameters,
    signature: order.signature,
    extraData: '0x',
    numerator: 1,
    denominator: 1,
  }
}

/**
 * Simulate the exact Seaport fill transaction from the connected wallet.
 * Run after needed approvals are in place; otherwise the simulation will fail
 * for missing taker approval rather than collection transfer policy.
 */
export async function simulateFulfillment(rawProvider, order, criteriaSelections = null) {
  const signer = await getSigner(rawProvider)
  const seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_FULFILL_ABI, signer)
  const value = nativeConsiderationValue(order)

  if (criteriaSelections) {
    const criteriaResolvers = buildCriteriaResolvers(order, criteriaSelections)
    if (criteriaResolvers.length > 0) {
      return seaport.fulfillAdvancedOrder.staticCall(
        advancedOrderFromOrder(order),
        criteriaResolvers,
        ZeroHash,
        ZeroAddress,
        { value }
      )
    }
  }

  return seaport.fulfillOrder.staticCall(order, ZeroHash, { value })
}

export async function fulfillOrder(rawProvider, order, criteriaSelections = null) {
  if (criteriaSelections) {
    const criteriaResolvers = buildCriteriaResolvers(order, criteriaSelections)
    if (criteriaResolvers.length > 0) {
      const signer = await getSigner(rawProvider)
      const seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_FULFILL_ABI, signer)
      const tx = await seaport.fulfillAdvancedOrder(
        advancedOrderFromOrder(order),
        criteriaResolvers,
        ZeroHash,
        ZeroAddress,
        { value: nativeConsiderationValue(order) }
      )
      return { tx, wait: () => tx.wait() }
    }
  }
  const signer = await getSigner(rawProvider)
  const seaport = new Contract(SEAPORT_ADDRESS, SEAPORT_FULFILL_ABI, signer)
  const tx = await seaport.fulfillOrder(order, ZeroHash, { value: nativeConsiderationValue(order) })
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
 * Query all OrderRegistered events from the OTCRegistry contract.
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
  const expectedZone = zoneAddress.toLowerCase()
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
            if (log.address.toLowerCase() !== expectedZone) continue
            let parsed
            try { parsed = iface.parseLog(log) } catch { continue }
            if (parsed?.name !== 'OrderRegistered') continue
            const extracted = verifyAndExtract(parsed)
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
    const extracted = verifyAndExtract(log)
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
export function deriveOrderStatus(seaportStatus, endTime, liveCounter, orderCounter) {
  if (!seaportStatus) return 'unknown'
  if (seaportStatus.isCancelled) return 'cancelled'
  if (seaportStatus.totalFilled > 0 && seaportStatus.totalFilled === seaportStatus.totalSize) return 'filled'
  if (liveCounter !== undefined && orderCounter !== undefined && BigInt(liveCounter) > BigInt(orderCounter)) return 'cancelled'
  if (endTime && Number(endTime) < Date.now() / 1000) return 'expired'
  return 'open'
}
