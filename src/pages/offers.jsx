import { useState, useEffect, useCallback } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router'
import { queryOrderEvents, getOrderStatus, deriveOrderStatus } from '../lib/contract'
import { checkHoldings } from '../lib/balances'
import { fetchMetadata } from '../lib/metadata'
import { resolveENSName } from '../lib/ens'
import AddressDisplay from '../components/address-display'
import { ZONE_ADDRESSES, CHAINS, WHITELISTED_ERC20 } from '../lib/constants'
import { formatUnits } from 'ethers'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const PAGE_SIZE = 20

// Chains that have a deployed zone contract
const DEPLOYED_CHAINS = Object.entries(ZONE_ADDRESSES)
  .filter(([, addr]) => addr !== null)
  .map(([id]) => Number(id))

// Map chain names to chain IDs for URL params
const CHAIN_NAME_TO_ID = {}
for (const [id, chain] of Object.entries(CHAINS)) {
  CHAIN_NAME_TO_ID[chain.name.toLowerCase()] = Number(id)
}

function parseChainParam(value) {
  if (!value || value === 'all') return 'all'
  // Try as chain ID first
  const asNum = Number(value)
  if (DEPLOYED_CHAINS.includes(asNum)) return String(asNum)
  // Try as chain name
  const id = CHAIN_NAME_TO_ID[value.toLowerCase()]
  if (id && DEPLOYED_CHAINS.includes(id)) return String(id)
  return 'all'
}

export default function Offers() {
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
          DEPLOYED_CHAINS.map(async (cid) => {
            const registrations = await queryOrderEvents(cid, ZONE_ADDRESSES[cid])
            const isPartial = registrations._partial
            const tagged = registrations.map((r) => ({ ...r, chainId: cid }))

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
                    const status = deriveOrderStatus(seaportStatus, endTime)
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

  // Check maker holdings for open offers
  useEffect(() => {
    const openOrders = orders.filter((o) => o.status === 'open' && o.order?.parameters)
    if (openOrders.length === 0) return

    let cancelled = false

    ;(async () => {
      const BATCH = 5
      const checks = []
      for (let i = 0; i < openOrders.length; i += BATCH) {
        if (cancelled) return
        const batch = openOrders.slice(i, i + BATCH)
        const results = await Promise.all(
          batch.map(async (o) => {
            const results = await checkHoldings(o.chainId, o.maker, o.order.parameters.offer)
            return { orderHash: o.orderHash, makerHoldsAll: results.every((h) => h.held) }
          })
        )
        checks.push(...results)
      }
      return checks
    })().then((checks) => {
      if (!checks) return
      if (cancelled) return
      const holdingsMap = {}
      for (const c of checks) holdingsMap[c.orderHash] = c.makerHoldsAll
      setOrders((prev) => prev.map((o) => ({
        ...o,
        makerHoldsAll: holdingsMap[o.orderHash] ?? true,
      })))
    })

    return () => { cancelled = true }
  }, [orders.length]) // re-run when orders finish loading

  // Reset pagination when filters change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [chainFilter, category, resolvedAddress, collectionParam])

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
    // Sort: valid first, then by soonest expiration
    filtered.sort((a, b) => {
      const aValid = a.makerHoldsAll !== false ? 1 : 0
      const bValid = b.makerHoldsAll !== false ? 1 : 0
      if (aValid !== bValid) return bValid - aValid
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
            {DEPLOYED_CHAINS.map((id) => (
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
            <OfferCard key={order.orderHash} order={order} invalidHoldings={order.makerHoldsAll === false} />
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
          <span className="offer-card-warning">Maker no longer holds assets</span>
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
              <span>{formatUnits(item.startAmount, 18)} {sym}</span>
            </span>
          )
        }
        if (it === 1) {
          const info = (WHITELISTED_ERC20[chainId] || {})[item.token]
          const amount = formatUnits(item.startAmount, info?.decimals ?? 18)
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

  useEffect(() => {
    let cancelled = false
    fetchMetadata(chainId, token, tokenId, itemType === 3 ? 1 : 0).then((m) => {
      if (!cancelled) setMeta(m)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [chainId, token, tokenId, itemType])

  return (
    <span className="offer-asset-item">
      <span className="offer-asset-thumb">
        {meta?.image ? (
          <img src={meta.image} alt={meta.name || ''} loading="lazy" />
        ) : (
          <span className="offer-asset-thumb-placeholder">?</span>
        )}
      </span>
      <span>{meta?.name || `#${tokenId}`}{Number(amount) > 1 && ` x${amount}`}</span>
    </span>
  )
}
