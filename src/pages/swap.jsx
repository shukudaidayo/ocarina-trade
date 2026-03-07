import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext } from 'react-router'
import { getOrderFromTx, getOrderStatus, fillOrder, cancelOrder, ensureApproval, ORDER_STATUS } from '../lib/contract'
import AssetCard from '../components/asset-card'
import AddressDisplay from '../components/address-display'
import WarningBanner from '../components/warning-banner'
import { truncateAddress } from '../lib/wallet'
import TxChecklist, { buildSteps } from '../components/tx-checklist'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export default function Swap() {
  const { chainId, txHash } = useParams()
  const wallet = useOutletContext()

  const [order, setOrder] = useState(null)
  const [contractAddress, setContractAddress] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [orderHash, setOrderHash] = useState(null)
  const [onChainStatus, setOnChainStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [steps, setSteps] = useState([])
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  // Fetch order data from tx hash
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await getOrderFromTx(Number(chainId), txHash)
        if (cancelled) return
        setOrder(data)
        setContractAddress(data.contractAddress)
        setOrderHash(data.orderHash)

        const status = await getOrderStatus(Number(chainId), data.contractAddress, data.orderHash)
        if (!cancelled) {
          setOnChainStatus(status)
          setStatusLoading(false)
        }
      } catch (err) {
        console.error('Failed to load order:', err)
        if (!cancelled) {
          setLoadError(err.message || 'Failed to load order from transaction.')
          setStatusLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [chainId, txHash])

  const handleFill = useCallback(async () => {
    if (!wallet || !order) return
    setError(null)
    setSubmitting(true)

    const txSteps = buildSteps(order.takerAssets, 'Accept Swap')
    setSteps(txSteps)

    function updateStep(index, update) {
      txSteps[index] = { ...txSteps[index], ...update }
      setSteps([...txSteps])
    }

    try {
      const approvalSteps = txSteps.filter((s) => s.type === 'approval')
      for (let i = 0; i < approvalSteps.length; i++) {
        const step = approvalSteps[i]
        const stepIndex = txSteps.indexOf(step)
        updateStep(stepIndex, { status: 'signing' })

        const tx = await ensureApproval(wallet.provider, wallet.chainId, step.tokenAddress, wallet.address)
        if (tx) {
          updateStep(stepIndex, { status: 'confirming' })
          await tx.wait()
        }
        updateStep(stepIndex, { status: 'done' })
      }

      const actionIndex = txSteps.length - 1
      updateStep(actionIndex, { status: 'signing' })
      const { wait } = await fillOrder(wallet.provider, wallet.chainId, order)
      updateStep(actionIndex, { status: 'confirming' })
      await wait()
      updateStep(actionIndex, { status: 'done' })

      setOnChainStatus(2) // FILLED
    } catch (err) {
      console.error(err)
      const failedIndex = txSteps.findIndex((s) => s.status === 'signing' || s.status === 'confirming')
      if (failedIndex !== -1) {
        updateStep(failedIndex, { status: 'failed', error: err.reason || err.message || 'Failed' })
      }
      setError(err.reason || err.message || 'Transaction failed')
    } finally {
      setSubmitting(false)
    }
  }, [wallet, order])

  const handleCancel = useCallback(async () => {
    if (!wallet || !orderHash) return
    setError(null)
    setSubmitting(true)

    const txSteps = [{ label: 'Cancel Order', status: 'pending', type: 'action' }]
    setSteps(txSteps)

    function updateStep(index, update) {
      txSteps[index] = { ...txSteps[index], ...update }
      setSteps([...txSteps])
    }

    try {
      updateStep(0, { status: 'signing' })
      const { wait } = await cancelOrder(wallet.provider, wallet.chainId, orderHash)
      updateStep(0, { status: 'confirming' })
      await wait()
      updateStep(0, { status: 'done' })

      setOnChainStatus(3) // CANCELLED
    } catch (err) {
      console.error(err)
      updateStep(0, { status: 'failed', error: err.reason || err.message || 'Failed' })
      setError(err.reason || err.message || 'Transaction failed')
    } finally {
      setSubmitting(false)
    }
  }, [wallet, orderHash])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  if (loadError) {
    return (
      <div className="page swap">
        <h1>Invalid Swap</h1>
        <p className="form-error">{loadError}</p>
      </div>
    )
  }

  if (!order) return <div className="page swap"><p className="text-muted">Loading order...</p></div>

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
      <TxChecklist steps={steps} />

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
