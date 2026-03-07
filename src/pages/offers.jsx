import { useState, useEffect } from 'react'
import { Link, useOutletContext } from 'react-router'
import { queryOrderEvents, getOrderStatus, deriveOrderStatus } from '../lib/contract'
import { truncateAddress } from '../lib/wallet'
import AddressDisplay from '../components/address-display'
import { ZONE_ADDRESSES } from '../lib/constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const PAGE_SIZE = 20

// Use the first chain that has a deployed zone contract
const DEFAULT_CHAIN_ID = Number(
  Object.entries(ZONE_ADDRESSES).find(([, addr]) => addr !== null)?.[0] ?? 0
)

export default function Offers() {
  const wallet = useOutletContext()
  const [tab, setTab] = useState('mine')
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  useEffect(() => {
    if (!DEFAULT_CHAIN_ID || !ZONE_ADDRESSES[DEFAULT_CHAIN_ID]) {
      setLoading(false)
      setError('No OTCZone deployed yet.')
      return
    }

    let cancelled = false
    async function load() {
      try {
        const registrations = await queryOrderEvents(
          DEFAULT_CHAIN_ID,
          ZONE_ADDRESSES[DEFAULT_CHAIN_ID],
        )

        if (cancelled) return

        // Fetch Seaport status for each order
        const enriched = await Promise.all(
          registrations.map(async (reg) => {
            try {
              const seaportStatus = await getOrderStatus(DEFAULT_CHAIN_ID, reg.orderHash)
              const endTime = reg.order?.parameters?.endTime
              const status = deriveOrderStatus(seaportStatus, endTime)
              return { ...reg, status }
            } catch {
              return { ...reg, status: 'unknown' }
            }
          })
        )

        if (cancelled) return

        // Most recent first
        enriched.reverse()
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
  }, [])

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

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  return (
    <div className="page offers">
      <h1>Offers</h1>

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

      {!loading && !error && tab === 'mine' && !wallet && (
        <p className="text-muted">Connect your wallet to see your offers.</p>
      )}

      {!loading && !error && filtered.length === 0 && (tab !== 'mine' || wallet) && (
        <p className="text-muted">
          {tab === 'mine' ? 'No offers involving your wallet.' :
           tab === 'open' ? 'No open offers.' : 'No completed swaps yet.'}
        </p>
      )}

      {!loading && visible.length > 0 && (
        <div className="offers-list">
          {visible.map((order) => (
            <OfferCard key={order.orderHash} order={order} chainId={DEFAULT_CHAIN_ID} />
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

function OfferCard({ order, chainId }) {
  const swapUrl = `/swap/${chainId}/${order.transactionHash}`
  const params = order.order?.parameters

  return (
    <Link to={swapUrl} className="offer-card">
      <div className="offer-card-side">
        <span className="offer-label">Maker</span>
        <AddressDisplay address={order.maker} chainId={chainId} />
        {params && <AssetSummary items={params.offer} />}
      </div>
      <div className="offer-card-arrow">&#8644;</div>
      <div className="offer-card-side">
        <span className="offer-label">Taker</span>
        {order.taker === ZERO_ADDRESS ? (
          <em>Anyone</em>
        ) : (
          <AddressDisplay address={order.taker} chainId={chainId} />
        )}
        {params && <AssetSummary items={params.consideration} />}
      </div>
      <div className="offer-card-meta">
        <span className={`status-badge status-${order.status}`}>
          {order.status}
        </span>
      </div>
    </Link>
  )
}

function AssetSummary({ items }) {
  return (
    <div className="offer-assets">
      {items.map((item, i) => (
        <span key={i} className="offer-asset-tag">
          {truncateAddress(item.token)}
          {item.identifierOrCriteria !== '0' && ` #${item.identifierOrCriteria}`}
          {Number(item.startAmount) > 1 && ` x${item.startAmount}`}
        </span>
      ))}
    </div>
  )
}
