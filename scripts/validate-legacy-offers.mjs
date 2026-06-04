import { readFile } from 'node:fs/promises'
import { JsonRpcProvider } from 'ethers'
import { Seaport } from '@opensea/seaport-js'
import { OrderType } from '@opensea/seaport-js/lib/constants.js'
import {
  DEPRECATED_OTCZONE_ADDRESSES,
} from '../src/lib/constants.js'

const ARCHIVE = new URL('../src/data/legacy-offers.json', import.meta.url)
const VALID_STATUSES = new Set(['filled', 'cancelled', 'expired'])
const VALID_RESOLUTION_TYPES = new Set(['fill', 'cancel'])

function fail(message) {
  throw new Error(`legacy archive validation failed: ${message}`)
}

function assertHex(value, bytes, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const expectedLength = 2 + bytes * 2
  if (!/^0x[0-9a-fA-F]+$/.test(value) || value.length !== expectedLength) {
    fail(`${label} must be ${bytes} bytes of hex`)
  }
}

const archive = JSON.parse(await readFile(ARCHIVE, 'utf8'))
if (archive.schemaVersion !== 1) fail('schemaVersion must be 1')
if (!Array.isArray(archive.records)) fail('records must be an array')

const seaport = new Seaport(new JsonRpcProvider('http://127.0.0.1:0'))
const seenKeys = new Set()

for (const [index, record] of archive.records.entries()) {
  const prefix = `record ${index}`
  if (record.source !== 'OTCZone') fail(`${prefix}: source must be OTCZone`)
  if (!VALID_STATUSES.has(record.status)) fail(`${prefix}: invalid status ${record.status}`)
  if (!DEPRECATED_OTCZONE_ADDRESSES[record.chainId]) fail(`${prefix}: unknown legacy chainId`)
  if (record.zoneAddress !== DEPRECATED_OTCZONE_ADDRESSES[record.chainId]) fail(`${prefix}: zoneAddress does not match deprecated constants`)

  assertHex(record.registrationTxHash, 32, `${prefix}: registrationTxHash`)
  assertHex(record.orderHash, 32, `${prefix}: orderHash`)
  assertHex(record.maker, 20, `${prefix}: maker`)
  assertHex(record.taker, 20, `${prefix}: taker`)
  if (!Number.isInteger(record.registrationBlockNumber) || record.registrationBlockNumber < 0) fail(`${prefix}: invalid registrationBlockNumber`)
  if (!Number.isInteger(record.registrationLogIndex) || record.registrationLogIndex < 0) fail(`${prefix}: invalid registrationLogIndex`)
  if (!record.order?.parameters) fail(`${prefix}: missing order.parameters`)
  if (record.order.parameters.zone?.toLowerCase() !== record.zoneAddress.toLowerCase()) fail(`${prefix}: order zone mismatch`)
  if (Number(record.order.parameters.orderType) !== OrderType.FULL_RESTRICTED) fail(`${prefix}: orderType must be FULL_RESTRICTED`)
  if (record.order.parameters.offerer?.toLowerCase() !== record.maker.toLowerCase()) fail(`${prefix}: maker must match order offerer`)

  const computedHash = seaport.getOrderHash(record.order.parameters)
  if (computedHash.toLowerCase() !== record.orderHash.toLowerCase()) fail(`${prefix}: orderHash mismatch`)

  const key = `${record.chainId}:${record.registrationTxHash.toLowerCase()}`
  if (seenKeys.has(key)) fail(`${prefix}: duplicate registration tx key`)
  seenKeys.add(key)

  if (record.resolution) {
    if (!VALID_RESOLUTION_TYPES.has(record.resolution.type)) fail(`${prefix}: invalid resolution type`)
    assertHex(record.resolution.txHash, 32, `${prefix}: resolution.txHash`)
    if (!Number.isInteger(record.resolution.blockNumber) || record.resolution.blockNumber < 0) fail(`${prefix}: invalid resolution.blockNumber`)
    if (record.resolution.fulfiller) assertHex(record.resolution.fulfiller, 20, `${prefix}: resolution.fulfiller`)
    if (record.status === 'filled' && record.resolution.type !== 'fill') fail(`${prefix}: filled records need fill resolution type`)
    if (record.status !== 'filled' && record.resolution.type === 'fill') fail(`${prefix}: only filled records can use fill resolution type`)
  }
}

console.log(`Validated ${archive.records.length} legacy non-open offer records`)
