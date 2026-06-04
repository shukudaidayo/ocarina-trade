import archive from '../data/legacy-offers.json'

function normalizeRecord(record) {
  return {
    archived: true,
    source: record.source,
    status: record.status,
    chainId: Number(record.chainId),
    zoneAddress: record.zoneAddress,
    transactionHash: record.registrationTxHash,
    blockNumber: record.registrationBlockNumber,
    logIndex: record.registrationLogIndex,
    orderHash: record.orderHash,
    maker: record.maker,
    taker: record.taker,
    memo: record.memo || '',
    order: record.order,
    resolution: record.resolution || null,
  }
}

export function getArchivedOfferRecords() {
  return (archive.records || []).map(normalizeRecord)
}

export function getArchivedOrderFromTx(chainId, txHash) {
  const targetChainId = Number(chainId)
  const targetHash = txHash?.toLowerCase()
  if (!targetHash) return null
  const record = (archive.records || []).find((r) =>
    Number(r.chainId) === targetChainId &&
    r.registrationTxHash?.toLowerCase() === targetHash
  )
  return record ? normalizeRecord(record) : null
}
