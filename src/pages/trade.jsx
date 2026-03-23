import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext } from 'react-router'
import { getOrderFromTx, getOrderStatus, fulfillOrder, cancelOrder, ensureApproval, deriveOrderStatus } from '../lib/contract'
import { checkHoldings } from '../lib/balances'
import AssetCard from '../components/asset-card'
import AddressDisplay from '../components/address-display'
import WarningBanner from '../components/warning-banner'
import { truncateAddress } from '../lib/wallet'
import TxChecklist, { buildSteps } from '../components/tx-checklist'
import { WHITELISTED_ERC20 } from '../lib/constants'
import { ItemType } from '@opensea/seaport-js/lib/constants'
import { formatUnits } from 'ethers'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Known Seaport/Zone error selectors
const KNOWN_ERRORS = {
  '0x82b42900': 'You are not the authorized taker for this trade.',
  '0x98d4901c': 'This order has been cancelled.',
}

function friendlyFillError(err) {
  const raw = err.data || err.message || ''
  // Check for known error selectors
  for (const [selector, msg] of Object.entries(KNOWN_ERRORS)) {
    if (raw.includes(selector)) return msg
  }
  // Seaport reverts with generic data when token transfers fail
  if (raw.includes('execution reverted') || err.code === 'CALL_EXCEPTION') {
    return 'This trade cannot be completed. The maker may no longer hold the offered assets, or approvals may have been revoked.'
  }
  if (err.code === 'ACTION_REJECTED' || raw.includes('user rejected')) {
    return 'Transaction rejected by user.'
  }
  return err.reason || err.message || 'Transaction failed'
}

export default function Trade() {
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
  const [offerHoldings, setOfferHoldings] = useState(null) // array parallel to offer items
  const [considerationHoldings, setConsiderationHoldings] = useState(null) // array parallel to consideration items

  // Fetch order data from tx hash
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await getOrderFromTx(Number(chainId), txHash)
        if (cancelled) return
        setOrderData(data)
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

  // Fetch order status separately so a transient RPC failure doesn't destroy loaded order data
  useEffect(() => {
    if (!orderData) return
    let cancelled = false
    async function load() {
      try {
        const status = await getOrderStatus(Number(chainId), orderData.orderHash)
        if (!cancelled) {
          const endTime = orderData.order.parameters.endTime
          setStatusLabel(deriveOrderStatus(status, endTime))
        }
      } catch (err) {
        console.error('Failed to load order status:', err)
        // Still show the order — just without status
      } finally {
        if (!cancelled) setStatusLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [orderData, chainId])

  // Check holdings when order is loaded and open
  useEffect(() => {
    if (!orderData || statusLabel !== 'open') return
    let cancelled = false
    const params = orderData.order.parameters

    // Check maker holds offered assets
    checkHoldings(Number(chainId), params.offerer, params.offer).then((results) => {
      if (!cancelled) setOfferHoldings(results)
    })

    // Check taker holds consideration assets (only if wallet is the valid taker)
    const takerAddr = orderData.taker
    const isValidTaker = wallet && (
      takerAddr === ZERO_ADDRESS ||
      wallet.address.toLowerCase() === takerAddr.toLowerCase()
    )
    if (isValidTaker) {
      checkHoldings(Number(chainId), wallet.address, params.consideration).then((results) => {
        if (!cancelled) setConsiderationHoldings(results)
      })
    } else {
      setConsiderationHoldings(null)
    }

    return () => { cancelled = true }
  }, [orderData, statusLabel, chainId, wallet])

  const handleFill = useCallback(async () => {
    if (!wallet || !orderData) return
    setError(null)
    setSubmitting(true)

    const params = orderData.order.parameters
    // Build taker assets from consideration items
    const takerAssets = params.consideration.map((c) => {
      const it = Number(c.itemType)
      return {
        token: c.token,
        tokenId: c.identifierOrCriteria,
        amount: c.startAmount,
        assetType: it === ItemType.NATIVE ? 'NATIVE' :
                   it === ItemType.ERC20 ? 'ERC20' :
                   it === ItemType.ERC1155 ? 'ERC1155' : 'ERC721',
        itemType: it,
      }
    })

    const txSteps = buildSteps(takerAssets, 'Accept Trade')
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

        const matchingAssets = takerAssets.filter((a) => a.token && a.token.toLowerCase() === step.tokenAddress.toLowerCase())
        const asset = matchingAssets[0]
        // Sum amounts for ERC-20 in case multiple consideration items use the same token
        const totalAmount = asset?.itemType === ItemType.ERC20
          ? matchingAssets.reduce((sum, a) => sum + BigInt(a.amount), 0n).toString()
          : undefined
        const tx = await ensureApproval(wallet.provider, step.tokenAddress, wallet.address, asset?.itemType ?? ItemType.ERC721, totalAmount)
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
      const msg = friendlyFillError(err)
      const failedIndex = txSteps.findIndex((s) => s.status === 'signing' || s.status === 'confirming')
      if (failedIndex !== -1) {
        updateStep(failedIndex, { status: 'failed', error: msg })
      }
      setError(msg)
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
      <div className="page trade">
        <h1>Invalid Trade</h1>
        <p className="form-error">{loadError}</p>
      </div>
    )
  }

  if (!orderData) return <div className="page trade"><p className="text-muted">Loading order...</p></div>

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
  const isRestricted = taker !== ZERO_ADDRESS
  const wrongTaker = wallet && isRestricted && !isTaker
  const wrongChain = wallet && wallet.chainId !== Number(chainId)

  // Parse offer/consideration for display (format fungible amounts to human-readable)
  function formatAmount(item) {
    const it = Number(item.itemType)
    if (it === ItemType.NATIVE) return formatUnits(item.startAmount, 18)
    if (it === ItemType.ERC20) {
      const info = (WHITELISTED_ERC20[Number(chainId)] || {})[item.token]
      return formatUnits(item.startAmount, info?.decimals ?? 18)
    }
    return item.startAmount
  }

  const offerAssets = params.offer.map((o) => ({
    token: o.token,
    tokenId: o.identifierOrCriteria,
    amount: formatAmount(o),
    itemType: Number(o.itemType),
  }))
  const considerationAssets = params.consideration.map((c) => ({
    token: c.token,
    tokenId: c.identifierOrCriteria,
    amount: formatAmount(c),
    itemType: Number(c.itemType),
  }))

  return (
    <div className="page trade">
      <h1>Trade Details</h1>

      <WarningBanner />

      <div className="trade-status-bar">
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

      <div className="trade-parties">
        <div className="trade-party">
          <h3>Maker sends</h3>
          <p className="party-address">
            <AddressDisplay address={maker} chainId={Number(chainId)} showFull />
            {isMaker && <span className="you-badge">you</span>}
          </p>
          <AssetList assets={offerAssets} chainId={chainId} holdings={offerHoldings} holdingsLabel="Maker" />
        </div>
        <div className="trade-arrow">&#8644;</div>
        <div className="trade-party">
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
          <AssetList assets={considerationAssets} chainId={chainId} holdings={considerationHoldings} holdingsLabel="You" />
        </div>
      </div>

      <div className="trade-meta">
        {orderData.memo && (
          <p className="trade-memo">
            <span className="meta-label">Memo:</span> {orderData.memo}
          </p>
        )}
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
        <p className="text-muted">Connect your wallet to accept or cancel this trade.</p>
      )}

      {wallet && wrongChain && (
        <p className="form-error">Switch your wallet to chain {chainId} to interact with this trade.</p>
      )}

      {wallet && !wrongChain && isOpen && !isExpired && wrongTaker && !isMaker && (
        <p className="form-error">This trade is restricted to a specific taker. Your connected wallet is not the authorized taker.</p>
      )}

      {wallet && !wrongChain && isOpen && !isExpired && isTaker && !isMaker && (() => {
        const makerMissing = offerHoldings && offerHoldings.some((h) => !h.held)
        const takerMissing = considerationHoldings && considerationHoldings.some((h) => !h.held)
        const blocked = makerMissing || takerMissing
        return (
          <>
            {makerMissing && (
              <p className="form-error">This trade cannot be completed — the maker no longer holds all offered assets.</p>
            )}
            {takerMissing && (
              <p className="form-error">You do not hold all required assets to accept this trade.</p>
            )}
            <button className="btn btn-primary" onClick={handleFill} disabled={submitting || blocked}>
              {submitting ? 'Accepting...' : 'Accept Trade'}
            </button>
          </>
        )
      })()}

      {wallet && !wrongChain && isOpen && isMaker && (
        <button className="btn btn-cancel" onClick={handleCancel} disabled={submitting}>
          {submitting ? 'Cancelling...' : 'Cancel Trade'}
        </button>
      )}
    </div>
  )
}

function AssetList({ assets, chainId, holdings, holdingsLabel }) {
  return (
    <div className="asset-list">
      {assets.map((asset, i) => (
        <div key={i}>
          <AssetCard asset={asset} chainId={Number(chainId)} />
          {holdings && !holdings[i]?.held && (
            <p className="asset-missing">{holdingsLabel} {holdingsLabel === 'You' ? 'do' : 'does'} not hold this asset</p>
          )}
        </div>
      ))}
    </div>
  )
}
