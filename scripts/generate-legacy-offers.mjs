import { writeFile } from 'node:fs/promises'
import { Interface, JsonRpcProvider, id, zeroPadValue } from 'ethers'
import { Seaport } from '@opensea/seaport-js'
import { OrderType } from '@opensea/seaport-js/lib/constants.js'
import {
  CHAINS,
  DEPRECATED_OTCZONE_ADDRESSES,
  DEPRECATED_OTCZONE_DEPLOY_BLOCKS,
  LEGACY_OTCZONE_ABI,
  SEAPORT_ADDRESS,
} from '../src/lib/constants.js'

const OUTFILE = new URL('../src/data/legacy-offers.json', import.meta.url)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ORDER_FULFILLED_TOPIC = id('OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])')
const ORDER_CANCELLED_TOPIC = id('OrderCancelled(bytes32,address,address)')

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
}

async function retry(fn, n = 3, delayMs = 500) {
  for (let i = 0; i < n; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === n - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)))
    }
  }
}

function deriveLegacyTaker(order) {
  const zoneHash = order.parameters.zoneHash || '0x'.padEnd(66, '0')
  return `0x${zoneHash.slice(-40).toLowerCase()}`
}

function deriveStatus(seaportStatus, endTime, liveCounter, orderCounter) {
  if (seaportStatus.isCancelled) return 'cancelled'
  if (BigInt(seaportStatus.totalFilled) > 0n && BigInt(seaportStatus.totalFilled) === BigInt(seaportStatus.totalSize)) return 'filled'
  if (liveCounter !== undefined && orderCounter !== undefined && BigInt(liveCounter) > BigInt(orderCounter)) return 'cancelled'
  if (endTime && Number(endTime) < Date.now() / 1000) return 'expired'
  return 'open'
}

function blockNumber(value) {
  if (value === undefined || value === null) return undefined
  return Number(value)
}

async function blockscoutJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Blockscout HTTP ${res.status} for ${url}`)
  return res.json()
}

async function queryRegistrationLogsViaBlockscout(chainId, zoneAddress, iface) {
  const chain = CHAINS[chainId]
  const startBlock = DEPRECATED_OTCZONE_DEPLOY_BLOCKS[chainId] || 0
  const topic0 = iface.getEvent('OrderRegistered').topicHash
  const url = `${chain.blockscoutApi}?module=logs&action=getLogs&address=${zoneAddress}&fromBlock=${startBlock}&toBlock=latest&topic0=${topic0}`
  const data = await blockscoutJson(url)
  if (data.status !== '1' || !Array.isArray(data.result)) {
    if (data.message === 'No logs found') return []
    throw new Error(`Unexpected logs response for chain ${chainId}: ${data.message || data.status}`)
  }
  return data.result
}

async function queryRegistrationLogsViaRpc(chainId, zoneAddress, provider, iface) {
  const startBlock = DEPRECATED_OTCZONE_DEPLOY_BLOCKS[chainId] || 0
  const latestBlock = await provider.getBlockNumber()
  const topic0 = iface.getEvent('OrderRegistered').topicHash
  const chunkSize = (Number(chainId) === 137 || Number(chainId) === 8453 || Number(chainId) === 57073) ? 9999 : 49999
  const logs = []

  for (let start = startBlock; start <= latestBlock; start += chunkSize + 1) {
    const end = Math.min(start + chunkSize, latestBlock)
    const chunk = await retry(() => provider.getLogs({
      address: zoneAddress,
      topics: [topic0],
      fromBlock: start,
      toBlock: end,
    }))
    logs.push(...chunk)
  }

  return logs
}

async function queryRegistrationLogs(chainId, zoneAddress, provider, iface) {
  const chain = CHAINS[chainId]
  if (chain.blockscoutApi) {
    try {
      return await queryRegistrationLogsViaBlockscout(chainId, zoneAddress, iface)
    } catch (err) {
      console.warn(`  Blockscout logs failed for ${chain.name}: ${err.message}`)
    }
  }
  return queryRegistrationLogsViaRpc(chainId, zoneAddress, provider, iface)
}

function extractLegacyRegistration(parsed, chainId, zoneAddress, seaport) {
  const args = parsed.args
  const order = decodeBase64Json(args.orderURI)
  if (!order?.parameters) return null

  const computedHash = seaport.getOrderHash(order.parameters)
  if (computedHash.toLowerCase() !== args.orderHash.toLowerCase()) return null
  if (order.parameters.zone?.toLowerCase() !== zoneAddress.toLowerCase()) return null
  if (Number(order.parameters.orderType) !== OrderType.FULL_RESTRICTED) return null

  return {
    source: 'OTCZone',
    chainId: Number(chainId),
    zoneAddress,
    orderHash: args.orderHash,
    maker: order.parameters.offerer,
    taker: deriveLegacyTaker(order),
    eventMaker: args.maker,
    eventTaker: args.taker,
    memo: args.memo || '',
    order,
  }
}

async function fetchRegistrations(chainId, zoneAddress) {
  const chain = CHAINS[chainId]
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const seaport = new Seaport(provider)
  const iface = new Interface(LEGACY_OTCZONE_ABI)
  const logs = await queryRegistrationLogs(chainId, zoneAddress, provider, iface)
  const registrations = []

  for (const log of logs) {
    let parsed
    try {
      parsed = iface.parseLog({ topics: log.topics, data: log.data })
    } catch {
      continue
    }
    if (parsed?.name !== 'OrderRegistered') continue
    const extracted = extractLegacyRegistration(parsed, chainId, zoneAddress, seaport)
    if (!extracted) continue
    registrations.push({
      ...extracted,
      registrationTxHash: log.transactionHash,
      registrationBlockNumber: blockNumber(log.blockNumber),
      registrationLogIndex: blockNumber(log.logIndex ?? log.index) ?? 0,
    })
  }

  return registrations
}

function dedupeByOrderHash(registrations) {
  const byHash = new Map()
  for (const record of registrations) {
    const key = `${record.chainId}:${record.orderHash.toLowerCase()}`
    const existing = byHash.get(key)
    if (!existing) {
      byHash.set(key, record)
      continue
    }
    const earlier = record.registrationBlockNumber < existing.registrationBlockNumber ||
      (record.registrationBlockNumber === existing.registrationBlockNumber &&
        record.registrationLogIndex < existing.registrationLogIndex)
    if (earlier) byHash.set(key, record)
  }
  return [...byHash.values()]
}

async function findSeaportResolution(chainId, zoneAddress, record, type) {
  const chain = CHAINS[chainId]
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const topic0 = type === 'fill' ? ORDER_FULFILLED_TOPIC : ORDER_CANCELLED_TOPIC
  const paddedOfferer = zeroPadValue(record.maker, 32)
  const paddedZone = zeroPadValue(zoneAddress, 32)
  const url = `${chain.blockscoutApi}?module=logs&action=getLogs&address=${SEAPORT_ADDRESS}&topic0=${topic0}&topic1=${paddedOfferer}&topic2=${paddedZone}&topic0_1_opr=and&topic1_2_opr=and&topic0_2_opr=and&fromBlock=0&toBlock=latest`
  const data = await blockscoutJson(url)
  if (data.status !== '1' || !Array.isArray(data.result)) return null

  const target = record.orderHash.toLowerCase()
  for (const log of data.result) {
    const dataHash = `0x${log.data.slice(2, 66)}`.toLowerCase()
    if (dataHash !== target) continue
    const resolution = {
      type,
      txHash: log.transactionHash,
      blockNumber: blockNumber(log.blockNumber),
    }
    if (type === 'fill') {
      const tx = await provider.getTransaction(log.transactionHash).catch(() => null)
      if (tx?.from) resolution.fulfiller = tx.from
    }
    return resolution
  }
  return null
}

async function enrichStatus(record) {
  const chain = CHAINS[record.chainId]
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const seaport = new Seaport(provider)
  const [seaportStatus, liveCounter] = await Promise.all([
    retry(() => seaport.getOrderStatus(record.orderHash)),
    retry(() => seaport.getCounter(record.maker)).catch(() => undefined),
  ])
  const status = deriveStatus(
    seaportStatus,
    record.order.parameters.endTime,
    liveCounter,
    record.order.parameters.counter
  )
  if (status === 'open') return null

  const out = {
    source: record.source,
    status,
    chainId: record.chainId,
    zoneAddress: record.zoneAddress,
    registrationTxHash: record.registrationTxHash,
    registrationBlockNumber: record.registrationBlockNumber,
    registrationLogIndex: record.registrationLogIndex,
    orderHash: record.orderHash,
    maker: record.maker,
    taker: record.taker === ZERO_ADDRESS ? ZERO_ADDRESS : record.taker,
    memo: record.memo,
    order: record.order,
  }

  if (status === 'filled') {
    const resolution = await findSeaportResolution(record.chainId, record.zoneAddress, record, 'fill')
    if (resolution) out.resolution = resolution
  } else if (status === 'cancelled' && seaportStatus.isCancelled) {
    const resolution = await findSeaportResolution(record.chainId, record.zoneAddress, record, 'cancel')
    if (resolution) out.resolution = resolution
  }

  return out
}

const allRegistrations = []
for (const [chainId, zoneAddress] of Object.entries(DEPRECATED_OTCZONE_ADDRESSES)) {
  console.log(`Querying deprecated OTCZone on ${CHAINS[chainId]?.name || chainId} (${zoneAddress})`)
  const registrations = await fetchRegistrations(Number(chainId), zoneAddress)
  console.log(`  found ${registrations.length} verified registrations`)
  allRegistrations.push(...registrations)
}

const deduped = dedupeByOrderHash(allRegistrations)
const records = []
for (const record of deduped) {
  const enriched = await enrichStatus(record)
  if (!enriched) continue
  records.push(enriched)
  console.log(`  archived ${enriched.status} ${CHAINS[enriched.chainId]?.name || enriched.chainId} ${enriched.orderHash}`)
}

records.sort((a, b) => (
  a.chainId - b.chainId ||
  a.registrationBlockNumber - b.registrationBlockNumber ||
  a.registrationLogIndex - b.registrationLogIndex
))

await writeFile(OUTFILE, `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`)
console.log(`Wrote ${records.length} legacy non-open offer records to ${OUTFILE.pathname}`)
