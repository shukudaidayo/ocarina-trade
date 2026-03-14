import { useState, useEffect } from 'react'
import { Link, useOutletContext } from 'react-router'
import { queryOrderEvents, getOrderStatus, deriveOrderStatus } from '../lib/contract'
import { checkHoldings } from '../lib/balances'
import { truncateAddress } from '../lib/wallet'
import AddressDisplay from '../components/address-display'
import { ZONE_ADDRESSES, WHITELISTED_ERC20 } from '../lib/constants'
import { formatUnits } from 'ethers'

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

  // Check maker holdings for open offers
  useEffect(() => {
    const openOrders = orders.filter((o) => o.status === 'open' && o.order?.parameters)
    if (openOrders.length === 0) return

    let cancelled = false

    Promise.all(
      openOrders.map(async (o) => {
        const results = await checkHoldings(DEFAULT_CHAIN_ID, o.maker, o.order.parameters.offer)
        return { orderHash: o.orderHash, makerHoldsAll: results.every((h) => h.held) }
      })
    ).then((checks) => {
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
            <OfferCard key={order.orderHash} order={order} chainId={DEFAULT_CHAIN_ID} invalidHoldings={order.makerHoldsAll === false} />
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
  const swapUrl = `/swap/${chainId}/${order.transactionHash}`
  const params = order.order?.parameters

  return (
    <Link to={swapUrl} className={`offer-card${invalidHoldings ? ' offer-card-invalid' : ''}`}>
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
          return <span key={i} className="offer-asset-tag">{formatUnits(item.startAmount, 18)} ETH</span>
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
