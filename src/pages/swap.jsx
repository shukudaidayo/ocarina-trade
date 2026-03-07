import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext } from 'react-router'
import { getOrderFromTx, getOrderStatus, fulfillOrder, cancelOrder, ensureApproval, deriveOrderStatus } from '../lib/contract'
import AssetCard from '../components/asset-card'
import AddressDisplay from '../components/address-display'
import WarningBanner from '../components/warning-banner'
import { truncateAddress } from '../lib/wallet'
import TxChecklist, { buildSteps } from '../components/tx-checklist'
import { ItemType } from '@opensea/seaport-js/lib/constants'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export default function Swap() {
  const { chainId, txHash } = useParams()
  const wallet = useOutletContext()

  const [orderData, setOrderData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [statusLabel, setStatusLabel] = useState(null)
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
        setOrderData(data)

        const status = await getOrderStatus(Number(chainId), data.orderHash)
        if (!cancelled) {
          const endTime = data.order.parameters.endTime
          setStatusLabel(deriveOrderStatus(status, endTime))
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
    if (!wallet || !orderData) return
    setError(null)
    setSubmitting(true)

    const params = orderData.order.parameters
    // Build taker assets from consideration items
    const takerAssets = params.consideration.map((c) => ({
      token: c.token,
      tokenId: c.identifierOrCriteria,
      amount: c.startAmount,
      assetType: Number(c.itemType) === ItemType.ERC20 ? 'ERC20' :
                 Number(c.itemType) === ItemType.ERC1155 ? 'ERC1155' : 'ERC721',
      itemType: Number(c.itemType),
    }))

    const txSteps = buildSteps(takerAssets, 'Accept Swap')
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

        const asset = takerAssets.find((a) => a.token.toLowerCase() === step.tokenAddress.toLowerCase())
        const tx = await ensureApproval(wallet.provider, step.tokenAddress, wallet.address, asset?.itemType ?? ItemType.ERC721)
        if (tx) {
          updateStep(stepIndex, { status: 'confirming' })
          await tx.wait()
        }
        updateStep(stepIndex, { status: 'done' })
      }

      const actionIndex = txSteps.length - 1
      updateStep(actionIndex, { status: 'signing' })
      const { wait } = await fulfillOrder(wallet.provider, orderData.order)
      updateStep(actionIndex, { status: 'confirming' })
      await wait()
      updateStep(actionIndex, { status: 'done' })

      setStatusLabel('filled')
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
  }, [wallet, orderData])

  const handleCancel = useCallback(async () => {
    if (!wallet || !orderData) return
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
      const { wait } = await cancelOrder(wallet.provider, orderData.order.parameters)
      updateStep(0, { status: 'confirming' })
      await wait()
      updateStep(0, { status: 'done' })

      setStatusLabel('cancelled')
    } catch (err) {
      console.error(err)
      updateStep(0, { status: 'failed', error: err.reason || err.message || 'Failed' })
      setError(err.reason || err.message || 'Transaction failed')
    } finally {
      setSubmitting(false)
    }
  }, [wallet, orderData])

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

  if (!orderData) return <div className="page swap"><p className="text-muted">Loading order...</p></div>

  const params = orderData.order.parameters
  const maker = params.offerer
  const taker = orderData.taker
  const isExpired = statusLabel === 'expired'
  const isMaker = wallet && wallet.address.toLowerCase() === maker.toLowerCase()
  const isTaker = wallet && (
    taker === ZERO_ADDRESS ||
    wallet.address.toLowerCase() === taker.toLowerCase()
  )
  const isOpen = statusLabel === 'open'
  const wrongChain = wallet && wallet.chainId !== Number(chainId)

  // Parse offer/consideration for display
  const offerAssets = params.offer.map((o) => ({
    token: o.token,
    tokenId: o.identifierOrCriteria,
    amount: o.startAmount,
    itemType: Number(o.itemType),
  }))
  const considerationAssets = params.consideration.map((c) => ({
    token: c.token,
    tokenId: c.identifierOrCriteria,
    amount: c.startAmount,
    itemType: Number(c.itemType),
  }))

  return (
    <div className="page swap">
      <h1>Swap Details</h1>

      <WarningBanner />

      <div className="swap-status-bar">
        {statusLoading ? (
          <span className="status-loading">Loading status...</span>
        ) : (
          <span className={`status-badge status-${statusLabel}`}>
            {statusLabel}
          </span>
        )}
        <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
      </div>

      <div className="swap-parties">
        <div className="swap-party">
          <h3>Maker sends</h3>
          <p className="party-address">
            <AddressDisplay address={maker} chainId={Number(chainId)} showFull />
            {isMaker && <span className="you-badge">you</span>}
          </p>
          <AssetList assets={offerAssets} chainId={chainId} />
        </div>
        <div className="swap-arrow">&#8644;</div>
        <div className="swap-party">
          <h3>Taker sends</h3>
          <p className="party-address">
            {taker === ZERO_ADDRESS ? (
              <em>Open to anyone</em>
            ) : (
              <>
                <AddressDisplay address={taker} chainId={Number(chainId)} showFull />
                {isTaker && taker !== ZERO_ADDRESS && <span className="you-badge">you</span>}
              </>
            )}
          </p>
          <AssetList assets={considerationAssets} chainId={chainId} />
        </div>
      </div>

      <div className="swap-meta">
        {params.endTime && Number(params.endTime) > 0 && (
          <p>
            <span className="meta-label">Expires:</span>{' '}
            {new Date(Number(params.endTime) * 1000).toLocaleString()}
            {isExpired && ' (expired)'}
          </p>
        )}
        <p>
          <span className="meta-label">Chain:</span> {chainId}
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
