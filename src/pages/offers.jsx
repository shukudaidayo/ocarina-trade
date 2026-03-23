import { useState, useEffect } from 'react'
import { Link, useOutletContext } from 'react-router'
import { queryOrderEvents, getOrderStatus, deriveOrderStatus } from '../lib/contract'
import { checkHoldings } from '../lib/balances'
import { truncateAddress } from '../lib/wallet'
import AddressDisplay from '../components/address-display'
import { ZONE_ADDRESSES, CHAINS, WHITELISTED_ERC20 } from '../lib/constants'
import { formatUnits } from 'ethers'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const PAGE_SIZE = 20

// Chains that have a deployed zone contract
const DEPLOYED_CHAINS = Object.entries(ZONE_ADDRESSES)
  .filter(([, addr]) => addr !== null)
  .map(([id]) => Number(id))

export default function Offers() {
  const wallet = useOutletContext()
  const [chainId, setChainId] = useState(() => {
    // Default to wallet chain if deployed, otherwise first deployed chain
    const walletChain = wallet?.chainId
    if (walletChain && ZONE_ADDRESSES[walletChain]) return walletChain
    return DEPLOYED_CHAINS[0] || 0
  })
  const [tab, setTab] = useState('mine')
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [partial, setPartial] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Follow wallet chain when it changes
  useEffect(() => {
    if (wallet?.chainId && ZONE_ADDRESSES[wallet.chainId]) {
      setChainId(wallet.chainId)
    }
  }, [wallet?.chainId])

  useEffect(() => {
    if (!chainId || !ZONE_ADDRESSES[chainId]) {
      setLoading(false)
      setError('No OTCZone deployed yet.')
      return
    }

    setOrders([])
    setLoading(true)
    setError(null)
    setPartial(false)

    let cancelled = false
    async function load() {
      try {
        const registrations = await queryOrderEvents(
          chainId,
          ZONE_ADDRESSES[chainId],
        )

        if (cancelled) return

        // Fetch Seaport status for each order (batched to avoid RPC rate limits)
        const BATCH_SIZE = 3
        const enriched = []
        for (let i = 0; i < registrations.length; i += BATCH_SIZE) {
          if (cancelled) return
          const batch = registrations.slice(i, i + BATCH_SIZE)
          const results = await Promise.all(
            batch.map(async (reg) => {
              try {
                const seaportStatus = await getOrderStatus(chainId, reg.orderHash)
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

        if (cancelled) return

        // Most recent first
        enriched.reverse()
        if (registrations._partial) setPartial(true)
        setOrders(enriched)
      } catch (err) {
        console.error('Failed to load offers:', err)
        if (!cancelled) setError('Failed to load offers. RPC may be rate-limited.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [chainId])

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
            const results = await checkHoldings(chainId, o.maker, o.order.parameters.offer)
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
  }, [orders.length, chainId]) // re-run when orders finish loading

  // Reset pagination when switching tabs
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [tab])

  const userAddr = wallet?.address?.toLowerCase()

  const filtered = orders.filter((o) => {
    if (tab === 'mine') {
      if (!userAddr) return false
      const isMaker = o.maker.toLowerCase() === userAddr
      const isTaker = o.taker !== ZERO_ADDRESS && o.taker.toLowerCase() === userAddr
      return isMaker || isTaker
    }
    if (tab === 'open') return o.status === 'open'
    if (tab === 'filled') return o.status === 'filled'
    return false
  })

  // Sort open offers: valid first, then invalid (maker doesn't hold assets)
  if (tab === 'open') {
    filtered.sort((a, b) => {
      const aValid = a.makerHoldsAll !== false ? 1 : 0
      const bValid = b.makerHoldsAll !== false ? 1 : 0
      return bValid - aValid
    })
  }

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  return (
    <div className="page offers">
      <h1>Offers</h1>

      {DEPLOYED_CHAINS.length > 1 && (
        <div className="chain-selector">
          {DEPLOYED_CHAINS.map((id) => (
            <button
              key={id}
              className={`tab ${id === chainId ? 'active' : ''}`}
              onClick={() => setChainId(id)}
            >
              {CHAINS[id]?.name || `Chain ${id}`}
            </button>
          ))}
        </div>
      )}

      <div className="offers-tabs">
        <button
          className={`tab ${tab === 'mine' ? 'active' : ''}`}
          onClick={() => setTab('mine')}
        >
          My Offers
        </button>
        <button
          className={`tab ${tab === 'open' ? 'active' : ''}`}
          onClick={() => setTab('open')}
        >
          All Open
        </button>
        <button
          className={`tab ${tab === 'filled' ? 'active' : ''}`}
          onClick={() => setTab('filled')}
        >
          Completed
        </button>
      </div>

      {loading && <p className="text-muted">Loading offers...</p>}
      {error && <p className="form-error">{error}</p>}
      {partial && !loading && <p className="text-muted">Only showing recent offers. Older offers may be missing.</p>}

      {!loading && !error && tab === 'mine' && !wallet && (
        <p className="text-muted">Connect your wallet to see your offers.</p>
      )}

      {!loading && !error && filtered.length === 0 && (tab !== 'mine' || wallet) && (
        <p className="text-muted">
          {tab === 'mine' ? 'No offers involving your wallet.' :
           tab === 'open' ? 'No open offers.' : 'No completed trades yet.'}
        </p>
      )}

      {!loading && visible.length > 0 && (
        <div className="offers-list">
          {visible.map((order) => (
            <OfferCard key={order.orderHash} order={order} chainId={chainId} invalidHoldings={order.makerHoldsAll === false} />
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

function OfferCard({ order, chainId, invalidHoldings }) {
  const tradeUrl = `/trade/${chainId}/${order.transactionHash}`
  const params = order.order?.parameters

  return (
    <Link to={tradeUrl} className={`offer-card${invalidHoldings ? ' offer-card-invalid' : ''}`}>
      <div className="offer-card-side">
        <span className="offer-label">Maker</span>
        <AddressDisplay address={order.maker} chainId={chainId} />
        {params && <AssetSummary items={params.offer} chainId={chainId} />}
      </div>
      <div className="offer-card-arrow">&#8644;</div>
      <div className="offer-card-side">
        <span className="offer-label">Taker</span>
        {order.taker === ZERO_ADDRESS ? (
          <em>Anyone</em>
        ) : (
          <AddressDisplay address={order.taker} chainId={chainId} />
        )}
        {params && <AssetSummary items={params.consideration} chainId={chainId} />}
      </div>
      <div className="offer-card-meta">
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
          return <span key={i} className="offer-asset-tag">{formatUnits(item.startAmount, 18)} {CHAINS[chainId]?.nativeSymbol || 'ETH'}</span>
        }
        if (it === 1) {
          const info = (WHITELISTED_ERC20[chainId] || {})[item.token]
          const amount = formatUnits(item.startAmount, info?.decimals ?? 18)
          return <span key={i} className="offer-asset-tag">{amount} {info?.symbol || truncateAddress(item.token)}</span>
        }
        return (
          <span key={i} className="offer-asset-tag">
            {truncateAddress(item.token)}
            {item.identifierOrCriteria !== '0' && ` #${item.identifierOrCriteria}`}
            {Number(item.startAmount) > 1 && ` x${item.startAmount}`}
          </span>
        )
      })}
    </div>
  )
}
