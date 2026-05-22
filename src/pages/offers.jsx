import { useState, useEffect, useCallback } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router'
import { queryOrderEvents, getOrderStatus, getCounter, deriveOrderStatus } from '../lib/contract'
import { getArchivedOfferRecords } from '../lib/legacy-offers'
import { checkMakerOfferAvailability } from '../lib/asset-checks'
import { fetchMetadata } from '../lib/metadata'
import { resolveENSName } from '../lib/ens'
import AddressDisplay from '../components/address-display'
import { ZONE_ADDRESSES, SELECTABLE_CHAIN_IDS, CHAINS, WHITELISTED_ERC20 } from '../lib/constants'
import { formatUnits } from 'ethers'
import { formatTokenAmount } from '../lib/wallet'
import { ItemType } from '@opensea/seaport-js/lib/constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const PAGE_SIZE = 20

const SELECTABLE_CHAINS = SELECTABLE_CHAIN_IDS.filter((id) => ZONE_ADDRESSES[id])

// Map chain names to chain IDs for URL params
const CHAIN_NAME_TO_ID = {}
for (const [id, chain] of Object.entries(CHAINS)) {
  CHAIN_NAME_TO_ID[chain.name.toLowerCase()] = Number(id)
}

function parseChainParam(value) {
  if (!value || value === 'all') return 'all'
  // Try as chain ID first
  const asNum = Number(value)
  if (SELECTABLE_CHAINS.includes(asNum)) return String(asNum)
  // Try as chain name
  const id = CHAIN_NAME_TO_ID[value.toLowerCase()]
  if (id && SELECTABLE_CHAINS.includes(id)) return String(id)
  return 'all'
}

function makerAvailabilityRank(order) {
  return order.makerAvailability === 'missing' ? 0 : 1
}

function orderAvailabilityKey(order) {
  return `${order.chainId}:${order.orderHash}`
}

export default function Offers() {
  useEffect(() => { document.title = 'Offers — ocarina.trade' }, [])
  const wallet = useOutletContext()
  const [searchParams, setSearchParams] = useSearchParams()

  // Read filters from URL
  const chainFilter = parseChainParam(searchParams.get('chain'))
  const category = searchParams.get('category') || 'open'
  const addressParam = searchParams.get('address') || ''
  const collectionParam = searchParams.get('collection') || ''

  // Resolved address filter (from ENS or direct)
  const [resolvedAddress, setResolvedAddress] = useState('')
  // Local input state for text fields (synced to URL on blur/enter)
  const [addressInput, setAddressInput] = useState(addressParam)
  const [collectionInput, setCollectionInput] = useState(collectionParam)

  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [partial, setPartial] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Helper to update a single URL param without clobbering others
  const setParam = useCallback((key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (!value) {
        next.delete(key)
      } else {
        next.set(key, value)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  // Resolve ENS name for address filter
  useEffect(() => {
    if (!addressParam) { setResolvedAddress(''); return }
    if (addressParam.startsWith('0x') && addressParam.length === 42) {
      setResolvedAddress(addressParam.toLowerCase())
      return
    }
    // Try ENS resolution
    let cancelled = false
    resolveENSName(addressParam).then((addr) => {
      if (cancelled) return
      setResolvedAddress(addr ? addr.toLowerCase() : '')
    })
    return () => { cancelled = true }
  }, [addressParam])

  // Sync local inputs when URL params change externally
  useEffect(() => { setAddressInput(addressParam) }, [addressParam])
  useEffect(() => { setCollectionInput(collectionParam) }, [collectionParam])

  // Load all chains once on mount
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const chainResults = await Promise.all(
          SELECTABLE_CHAINS.map(async (cid) => {
            const registrations = await queryOrderEvents(cid, ZONE_ADDRESSES[cid])
            const isPartial = registrations._partial
            const tagged = registrations.map((r) => ({ ...r, chainId: cid }))

            const uniqueMakers = [...new Set(tagged.map((r) => r.maker))]
            const counterMap = {}
            await Promise.all(
              uniqueMakers.map(async (maker) => {
                try { counterMap[maker] = await getCounter(cid, maker) } catch { /* leave undefined */ }
              })
            )

            const BATCH_SIZE = 3
            const enriched = []
            for (let i = 0; i < tagged.length; i += BATCH_SIZE) {
              if (cancelled) return []
              const batch = tagged.slice(i, i + BATCH_SIZE)
              const results = await Promise.all(
                batch.map(async (reg) => {
                  try {
                    const seaportStatus = await getOrderStatus(cid, reg.orderHash)
                    const endTime = reg.order?.parameters?.endTime
                    const status = deriveOrderStatus(seaportStatus, endTime, counterMap[reg.maker], reg.order?.parameters?.counter)
                    return { ...reg, status }
                  } catch {
                    return { ...reg, status: 'unknown' }
                  }
                })
              )
              enriched.push(...results)
            }

            if (isPartial) enriched._partial = true
            return enriched
          })
        )

        if (cancelled) return

        const allOrders = chainResults.flat()
        allOrders.reverse()
        allOrders.push(...getArchivedOfferRecords())
        const anyPartial = chainResults.some((r) => r._partial)
        if (anyPartial) setPartial(true)
        setOrders(allOrders)
      } catch (err) {
        console.error('Failed to load offers:', err)
        if (!cancelled) setError('Failed to load offers. RPC may be rate-limited.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Reset pagination when filters change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [chainFilter, category, resolvedAddress, collectionParam])

  // Check maker holdings for open offers after the order statuses have loaded.
  useEffect(() => {
    const pending = orders.filter((order) =>
      order.status === 'open' &&
      order.order?.parameters?.offer &&
      !order.makerAvailability
    )
    if (pending.length === 0) return undefined

    let cancelled = false

    async function checkPending() {
      const BATCH_SIZE = 5
      const results = []
      for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        if (cancelled) return
        const batch = pending.slice(i, i + BATCH_SIZE)
        const checks = await Promise.all(batch.map(async (order) => {
          const availability = await checkMakerOfferAvailability(
            order.chainId,
            order.maker,
            order.order.parameters.offer
          ).catch(() => ({ status: 'unknown', reason: 'Unable to verify maker holdings' }))
          return { key: orderAvailabilityKey(order), availability }
        }))
        results.push(...checks)
      }

      if (cancelled) return
      const byOrder = new Map(results.map(({ key, availability }) => [key, availability]))
      setOrders((prev) => prev.map((order) => {
        const availability = byOrder.get(orderAvailabilityKey(order))
        if (!availability) return order
        return {
          ...order,
          makerAvailability: availability.status,
          makerAvailabilityReason: availability.reason,
        }
      }))
    }

    checkPending()
    return () => { cancelled = true }
  }, [orders])

  const normalizedCollection = collectionParam ? collectionParam.toLowerCase() : ''

  const filtered = orders.filter((o) => {
    // Chain filter
    if (chainFilter !== 'all' && o.chainId !== Number(chainFilter)) return false

    // Status filter
    if (category === 'open') {
      if (o.status !== 'open') return false
    }

    // Address filter — match maker or taker
    if (resolvedAddress) {
      const isMaker = o.maker.toLowerCase() === resolvedAddress
      const isTaker = o.taker !== ZERO_ADDRESS && o.taker.toLowerCase() === resolvedAddress
      if (!isMaker && !isTaker) return false
    }

    // Collection filter — match if any offer or consideration item involves this contract
    if (normalizedCollection) {
      const params = o.order?.parameters
      if (!params) return false
      const allItems = [...(params.offer || []), ...(params.consideration || [])]
      const hasCollection = allItems.some((item) =>
        item.token && item.token.toLowerCase() === normalizedCollection
      )
      if (!hasCollection) return false
    }

    return true
  })

  if (category === 'open') {
    // Sort open offers by holdings availability, then soonest expiration.
    filtered.sort((a, b) => {
      const availabilityDiff = makerAvailabilityRank(b) - makerAvailabilityRank(a)
      if (availabilityDiff) return availabilityDiff
      const aEnd = Number(a.order?.parameters?.endTime || 0)
      const bEnd = Number(b.order?.parameters?.endTime || 0)
      if (!aEnd && !bEnd) return 0
      if (!aEnd) return 1
      if (!bEnd) return -1
      return aEnd - bEnd
    })
  } else {
    // Sort by creation time, newest first
    filtered.sort((a, b) => {
      const aStart = Number(a.order?.parameters?.startTime || 0)
      const bStart = Number(b.order?.parameters?.startTime || 0)
      return bStart - aStart
    })
  }

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  return (
    <div className="page offers">
      <h1>Offers</h1>

      <div className="offers-filters">
        <label>
          Chain
          <select value={chainFilter} onChange={(e) => setParam('chain', e.target.value)}>
            <option value="all">All Chains</option>
            {SELECTABLE_CHAINS.map((id) => (
              <option key={id} value={id}>{CHAINS[id]?.name || `Chain ${id}`}</option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={category} onChange={(e) => setParam('category', e.target.value)}>
            <option value="open">Open</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Address
          <span className="offers-address-input">
            <input
              type="text"
              placeholder="0x... or ENS name"
              value={addressInput}
              onChange={(e) => { setAddressInput(e.target.value); if (!e.target.value) setParam('address', '') }}
              onPaste={(e) => { const v = e.clipboardData.getData('text').trim(); if (v) { setAddressInput(v); setParam('address', v) } }}
              onBlur={() => setParam('address', addressInput.trim())}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur() } }}
            />
            {wallet && (
              <button
                type="button"
                className="offers-me-btn"
                onClick={() => { setAddressInput(wallet.address); setParam('address', wallet.address) }}
              >Me</button>
            )}
          </span>
        </label>
        <label>
          Collection
          <input
            type="text"
            placeholder="Contract address"
            value={collectionInput}
            onChange={(e) => { setCollectionInput(e.target.value); if (!e.target.value) setParam('collection', '') }}
            onPaste={(e) => { const v = e.clipboardData.getData('text').trim(); if (v) { setCollectionInput(v); setParam('collection', v) } }}
            onBlur={() => setParam('collection', collectionInput.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur() } }}
          />
        </label>
      </div>

      {loading && <p className="text-muted">Loading offers...</p>}
      {error && <p className="form-error">{error}</p>}
      {partial && !loading && <p className="text-muted">Only showing recent offers. Older offers may be missing.</p>}

      {!loading && !error && filtered.length === 0 && (
        <p className="text-muted">No offers found.</p>
      )}

      {!loading && visible.length > 0 && (
        <div className="offers-list">
          {visible.map((order) => (
            <OfferCard
              key={`${order.chainId}:${order.orderHash}`}
              order={order}
              invalidHoldings={order.makerAvailability === 'missing'}
            />
          ))}
        </div>
      )}

      {hasMore && (
        <button
          className="btn btn-secondary"
          style={{ marginTop: '1rem' }}
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
        >
          Load More ({filtered.length - visibleCount} remaining)
        </button>
      )}
    </div>
  )
}

const TOKEN_LOGOS = {
  ETH: new URL('../assets/tokens/eth.png', import.meta.url).href,
  POL: new URL('../assets/tokens/pol.png', import.meta.url).href,
  WETH: new URL('../assets/tokens/weth.png', import.meta.url).href,
  USDC: new URL('../assets/tokens/usdc.png', import.meta.url).href,
  USDT: new URL('../assets/tokens/usdt.png', import.meta.url).href,
  USDT0: new URL('../assets/tokens/usdt.png', import.meta.url).href,
  USDS: new URL('../assets/tokens/usds.png', import.meta.url).href,
  EURC: new URL('../assets/tokens/eurc.png', import.meta.url).href,
}

function OfferCard({ order, invalidHoldings }) {
  const { chainId } = order
  const offerUrl = `/offer/${chainId}/${order.transactionHash}`
  const params = order.order?.parameters

  return (
    <Link to={offerUrl} className={`offer-card${invalidHoldings ? ' offer-card-invalid' : ''}`}>
      <div className="offer-card-side">
        <div className="offer-card-from">
          From <AddressDisplay address={order.maker} chainId={chainId} asSpan />
        </div>
        {params && <AssetSummary items={params.offer} chainId={chainId} />}
      </div>
      <div className="offer-card-side">
        <div className="offer-card-from">
          {order.taker === ZERO_ADDRESS ? (
            <>From Anyone</>
          ) : (
            <>From <AddressDisplay address={order.taker} chainId={chainId} asSpan /></>
          )}
        </div>
        {params && <AssetSummary items={params.consideration} chainId={chainId} />}
      </div>
      <div className="offer-card-meta">
        <span className="offer-card-chain">{CHAINS[chainId]?.name}</span>
        <span className={`status-badge status-${order.status}`}>
          {order.status}
        </span>
        {invalidHoldings && (
          <span className="offer-card-warning">
            Maker no longer holds assets
          </span>
        )}
      </div>
    </Link>
  )
}

function AssetSummary({ items, chainId }) {
  return (
    <div className="offer-assets">
      {items.map((item, i) => {
        const it = Number(item.itemType)
        if (it === 0) {
          const sym = CHAINS[chainId]?.nativeSymbol || 'ETH'
          return (
            <span key={i} className="offer-asset-item">
              {TOKEN_LOGOS[sym] && <img src={TOKEN_LOGOS[sym]} alt={sym} className="offer-asset-logo" />}
              <span>{formatTokenAmount(formatUnits(item.startAmount, 18))} {sym}</span>
            </span>
          )
        }
        if (it === 1) {
          const info = (WHITELISTED_ERC20[chainId] || {})[item.token]
          const amount = formatTokenAmount(formatUnits(item.startAmount, info?.decimals ?? 18))
          const sym = info?.symbol || '???'
          return (
            <span key={i} className="offer-asset-item">
              {TOKEN_LOGOS[sym] && <img src={TOKEN_LOGOS[sym]} alt={sym} className="offer-asset-logo" />}
              <span>{amount} {sym}</span>
            </span>
          )
        }
        return (
          <NFTAssetItem key={i} chainId={chainId} token={item.token} tokenId={item.identifierOrCriteria} itemType={it} amount={item.startAmount} />
        )
      })}
    </div>
  )
}

function NFTAssetItem({ chainId, token, tokenId, itemType, amount }) {
  const [meta, setMeta] = useState(null)
  const isCriteria = itemType === ItemType.ERC721_WITH_CRITERIA || itemType === ItemType.ERC1155_WITH_CRITERIA

  useEffect(() => {
    if (isCriteria) return
    let cancelled = false
    fetchMetadata(chainId, token, tokenId, itemType === 3 ? 1 : 0).then((m) => {
      if (!cancelled) setMeta(m)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [chainId, token, tokenId, itemType, isCriteria])

  return (
    <span className="offer-asset-item">
      <span className="offer-asset-thumb">
        {meta?.image ? (
          <img src={meta.image} alt={meta.name || ''} loading="lazy" />
        ) : (
          <span className="offer-asset-thumb-placeholder">{isCriteria ? 'Any' : '?'}</span>
        )}
      </span>
      <span>{isCriteria ? 'Any token' : (meta?.name || `#${tokenId}`)}{Number(amount) > 1 && ` x${amount}`}</span>
    </span>
  )
}
