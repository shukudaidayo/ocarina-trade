import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext } from 'react-router'
import { decodeOrder } from '../lib/encoding'
import { getOrderStatus, fillOrder, cancelOrder, ensureApproval, computeOrderHash, ORDER_STATUS } from '../lib/contract'
import AssetCard from '../components/asset-card'
import AddressDisplay from '../components/address-display'
import WarningBanner from '../components/warning-banner'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export default function Swap() {
  const { chainId, contractAddress, encodedOrder } = useParams()
  const wallet = useOutletContext()

  const [order, setOrder] = useState(null)
  const [decodeError, setDecodeError] = useState(null)
  const [orderHash, setOrderHash] = useState(null)
  const [onChainStatus, setOnChainStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [actionStatus, setActionStatus] = useState(null)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  // Decode order from URL
  useEffect(() => {
    try {
      const decoded = decodeOrder(encodedOrder)
      setOrder(decoded)
    } catch {
      setDecodeError('Invalid swap link. The order data could not be decoded.')
    }
  }, [encodedOrder])

  // Compute hash and fetch on-chain status
  useEffect(() => {
    if (!order) return

    let cancelled = false
    async function fetchStatus() {
      try {
        const hash = computeOrderHash(
          order.maker,
          order.taker,
          order.makerAssets,
          order.takerAssets,
          order.expiration,
          order.salt,
        )
        setOrderHash(hash)

        const status = await getOrderStatus(Number(chainId), contractAddress, hash)
        if (!cancelled) {
          setOnChainStatus(status)
          setStatusLoading(false)
        }
      } catch (err) {
        console.error('Failed to fetch order status:', err)
        if (!cancelled) {
          setOnChainStatus(null)
          setStatusLoading(false)
        }
      }
    }
    fetchStatus()
    return () => { cancelled = true }
  }, [order, chainId, contractAddress])

  const handleFill = useCallback(async () => {
    if (!wallet || !order) return
    setError(null)
    setSubmitting(true)

    try {
      // Approve taker assets
      const uniqueTokens = [...new Set(order.takerAssets.map((a) => a.token.toLowerCase()))]
      for (const tokenAddr of uniqueTokens) {
        setActionStatus(`Approving ${truncateAddress(tokenAddr)}...`)
        const tx = await ensureApproval(wallet.provider, wallet.chainId, tokenAddr, wallet.address)
        if (tx) await tx.wait()
      }

      setActionStatus('Sending fillOrder transaction...')
      await fillOrder(wallet.provider, wallet.chainId, order)

      setOnChainStatus(2) // FILLED
      setActionStatus(null)
    } catch (err) {
      console.error(err)
      setError(err.reason || err.message || 'Transaction failed')
      setActionStatus(null)
    } finally {
      setSubmitting(false)
    }
  }, [wallet, order])

  const handleCancel = useCallback(async () => {
    if (!wallet || !orderHash) return
    setError(null)
    setSubmitting(true)

    try {
      setActionStatus('Sending cancelOrder transaction...')
      await cancelOrder(wallet.provider, wallet.chainId, orderHash)

      setOnChainStatus(3) // CANCELLED
      setActionStatus(null)
    } catch (err) {
      console.error(err)
      setError(err.reason || err.message || 'Transaction failed')
      setActionStatus(null)
    } finally {
      setSubmitting(false)
    }
  }, [wallet, orderHash])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  if (decodeError) {
    return (
      <div className="page swap">
        <h1>Invalid Swap</h1>
        <p className="form-error">{decodeError}</p>
      </div>
    )
  }

  if (!order) return null

  const isExpired = order.expiration > 0 && order.expiration < Date.now() / 1000
  const isMaker = wallet && wallet.address.toLowerCase() === order.maker.toLowerCase()
  const isTaker = wallet && (
    order.taker === ZERO_ADDRESS ||
    wallet.address.toLowerCase() === order.taker.toLowerCase()
  )
  const isOpen = onChainStatus === 1
  const statusLabel = onChainStatus !== null ? ORDER_STATUS[onChainStatus] : null
  const wrongChain = wallet && wallet.chainId !== Number(chainId)

  return (
    <div className="page swap">
      <h1>Swap Details</h1>

      <WarningBanner />

      <div className="swap-status-bar">
        {statusLoading ? (
          <span className="status-loading">Loading status...</span>
        ) : (
          <span className={`status-badge status-${statusLabel?.toLowerCase()}`}>
            {statusLabel}
          </span>
        )}
        {isExpired && isOpen && <span className="status-badge status-expired">Expired</span>}
        <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
      </div>

      <div className="swap-parties">
        <div className="swap-party">
          <h3>Maker sends</h3>
          <p className="party-address">
            <AddressDisplay address={order.maker} chainId={Number(chainId)} showFull />
            {isMaker && <span className="you-badge">you</span>}
          </p>
          <AssetList assets={order.makerAssets} chainId={chainId} />
        </div>
        <div className="swap-arrow">&#8644;</div>
        <div className="swap-party">
          <h3>Taker sends</h3>
          <p className="party-address">
            {order.taker === ZERO_ADDRESS ? (
              <em>Open to anyone</em>
            ) : (
              <>
                <AddressDisplay address={order.taker} chainId={Number(chainId)} showFull />
                {isTaker && order.taker !== ZERO_ADDRESS && <span className="you-badge">you</span>}
              </>
            )}
          </p>
          <AssetList assets={order.takerAssets} chainId={chainId} />
        </div>
      </div>

      <div className="swap-meta">
        {order.expiration > 0 && (
          <p>
            <span className="meta-label">Expires:</span>{' '}
            {new Date(order.expiration * 1000).toLocaleString()}
            {isExpired && ' (expired)'}
          </p>
        )}
        <p>
          <span className="meta-label">Chain:</span> {chainId}
        </p>
        <p>
          <span className="meta-label">Contract:</span>{' '}
          <code>{contractAddress}</code>
        </p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {actionStatus && <p className="form-status">{actionStatus}</p>}

      {!wallet && isOpen && (
        <p className="text-muted">Connect your wallet to accept or cancel this swap.</p>
      )}

      {wallet && wrongChain && (
        <p className="form-error">Switch your wallet to chain {chainId} to interact with this swap.</p>
      )}

      {wallet && !wrongChain && isOpen && !isExpired && isTaker && !isMaker && (
        <button className="btn btn-primary" onClick={handleFill} disabled={submitting}>
          {submitting ? 'Accepting...' : 'Accept Swap'}
        </button>
      )}

      {wallet && !wrongChain && isOpen && isMaker && (
        <button className="btn btn-cancel" onClick={handleCancel} disabled={submitting}>
          {submitting ? 'Cancelling...' : 'Cancel Swap'}
        </button>
      )}
    </div>
  )
}

function AssetList({ assets, chainId }) {
  return (
    <div className="asset-list">
      {assets.map((asset, i) => (
        <AssetCard key={i} asset={asset} chainId={Number(chainId)} />
      ))}
    </div>
  )
}
