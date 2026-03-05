import { useState, useEffect } from 'react'
import { Link } from 'react-router'
import { queryOrderEvents } from '../lib/contract'
import { encodeOrder } from '../lib/encoding'
import { truncateAddress } from '../lib/wallet'
import AddressDisplay from '../components/address-display'
import { CONTRACT_ADDRESSES, CHAINS } from '../lib/constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ASSET_TYPE_LABELS = ['ERC-721', 'ERC-1155']

// Use the first chain that has a deployed contract
const DEFAULT_CHAIN_ID = Number(
  Object.entries(CONTRACT_ADDRESSES).find(([, addr]) => addr !== null)?.[0] ?? 0
)

export default function Offers() {
  const [view, setView] = useState('open')
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!DEFAULT_CHAIN_ID || !CONTRACT_ADDRESSES[DEFAULT_CHAIN_ID]) {
      setLoading(false)
      setError('No contract deployed yet.')
      return
    }

    let cancelled = false
    async function load() {
      try {
        const { created, filledHashes, cancelledHashes } = await queryOrderEvents(
          DEFAULT_CHAIN_ID,
          CONTRACT_ADDRESSES[DEFAULT_CHAIN_ID],
        )

        if (cancelled) return

        const enriched = created.map((order) => {
          let status = 'open'
          if (filledHashes.has(order.orderHash)) status = 'filled'
          else if (cancelledHashes.has(order.orderHash)) status = 'cancelled'

          if (status === 'open' && order.expiration > 0 && order.expiration < Date.now() / 1000) {
            status = 'expired'
          }

          return { ...order, status }
        })

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

  const filtered = orders.filter((o) => {
    if (view === 'open') return o.status === 'open'
    if (view === 'filled') return o.status === 'filled'
    return false
  })

  return (
    <div className="page offers">
      <h1>Browse Offers</h1>

      <div className="offers-tabs">
        <button
          className={`tab ${view === 'open' ? 'active' : ''}`}
          onClick={() => setView('open')}
        >
          Open
        </button>
        <button
          className={`tab ${view === 'filled' ? 'active' : ''}`}
          onClick={() => setView('filled')}
        >
          Completed
        </button>
      </div>

      {loading && <p className="text-muted">Loading offers...</p>}
      {error && <p className="form-error">{error}</p>}

      {!loading && !error && filtered.length === 0 && (
        <p className="text-muted">
          {view === 'open' ? 'No open offers.' : 'No completed swaps yet.'}
        </p>
      )}

      {!loading && filtered.length > 0 && (
        <div className="offers-list">
          {filtered.map((order) => (
            <OfferCard key={order.orderHash} order={order} chainId={DEFAULT_CHAIN_ID} />
          ))}
        </div>
      )}
    </div>
  )
}

function OfferCard({ order, chainId }) {
  const contractAddress = CONTRACT_ADDRESSES[chainId]
  const encoded = encodeOrder({
    maker: order.maker,
    taker: order.taker,
    makerAssets: order.makerAssets,
    takerAssets: order.takerAssets,
    expiration: order.expiration,
    salt: order.salt,
  })
  const swapUrl = `/swap/${chainId}/${contractAddress}/${encoded}`

  return (
    <Link to={swapUrl} className="offer-card">
      <div className="offer-card-side">
        <span className="offer-label">Maker</span>
        <AddressDisplay address={order.maker} chainId={chainId} />
        <AssetSummary assets={order.makerAssets} />
      </div>
      <div className="offer-card-arrow">&#8644;</div>
      <div className="offer-card-side">
        <span className="offer-label">Taker</span>
        {order.taker === ZERO_ADDRESS ? (
          <em>Anyone</em>
        ) : (
          <AddressDisplay address={order.taker} chainId={chainId} />
        )}
        <AssetSummary assets={order.takerAssets} />
      </div>
      <div className="offer-card-meta">
        <span className={`status-badge status-${order.status}`}>
          {order.status}
        </span>
      </div>
    </Link>
  )
}

function AssetSummary({ assets }) {
  return (
    <div className="offer-assets">
      {assets.map((a, i) => (
        <span key={i} className="offer-asset-tag">
          {truncateAddress(a.token)} #{a.tokenId}
          {a.assetType === 1 && ` x${a.amount}`}
        </span>
      ))}
    </div>
  )
}
