import { useState } from 'react'
import { useCreateFlow } from './context'
import { CHAINS } from '../../lib/constants'
import AddressDisplay from '../address-display'
import AssetCard from '../asset-card'

const EXPIRY_PRESETS = [
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
]

export default function StepReview({ wallet }) {
  const { next, back, chainId, taker, takerENS, makerAssets, takerAssets, expiration, setExpiration, memo, setMemo } = useCreateFlow()
  const [showExpiry, setShowExpiry] = useState(false)
  const isSelf = taker && wallet?.address && taker.toLowerCase() === wallet.address.toLowerCase()

  // Default 30 days
  const expirationDate = expiration
    ? new Date(expiration * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  // Compute a human-readable label for the expiration
  const expiryLabel = (() => {
    const diffDays = Math.round((expirationDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    const match = EXPIRY_PRESETS.find((p) => Math.abs(p.days - diffDays) <= 1)
    return match ? match.label : 'custom'
  })()

  const setExpiryDays = (days) => {
    setExpiration(Math.floor(Date.now() / 1000) + days * 24 * 60 * 60)
    setShowExpiry(false)
  }

  const handleMemoChange = (e) => {
    const val = e.target.value
    const encoded = new TextEncoder().encode(val)
    if (encoded.length <= 280) {
      setMemo(val)
    } else {
      setMemo(new TextDecoder().decode(encoded.slice(0, 280)))
    }
  }

  return (
    <div className="wizard-screen">
      <h2>Review your offer</h2>

      <div className="review-section">
        <div className="review-side">
          <h3>You're offering</h3>
          <div className="review-assets">
            {makerAssets.map((asset, i) => (
              <AssetCard key={i} asset={asset} chainId={chainId} compact={false} showUnverifiedWarning />
            ))}
          </div>
        </div>


        <div className="review-side">
          <h3>You're receiving</h3>
          <div className="review-assets">
            {takerAssets.map((asset, i) => (
              <AssetCard key={i} asset={asset} chainId={chainId} compact={false} showUnverifiedWarning />
            ))}
          </div>
        </div>
      </div>

      <div className="review-meta">
        <div className="review-meta-row">
          <span className="meta-label">From:</span>
          <AddressDisplay address={wallet.address} chainId={chainId} />
        </div>
        <div className="review-meta-row">
          <span className="meta-label">To:</span>
          {taker ? (
            <AddressDisplay address={taker} chainId={chainId} nameOverride={takerENS} />
          ) : (
            <em>Anyone</em>
          )}
        </div>
        <div className="review-meta-row">
          <span className="meta-label">Chain:</span>
          <span>{CHAINS[chainId]?.name || chainId}</span>
        </div>
        <div className="review-meta-row">
          <span className="meta-label">Expires:</span>
          <span>{expirationDate.toLocaleDateString()} ({expiryLabel})</span>
          <button type="button" className="btn-link btn-sm" onClick={() => setShowExpiry(!showExpiry)}>
            Change
          </button>
        </div>
        {showExpiry && (
          <div className="expiry-presets">
            {EXPIRY_PRESETS.map((p) => (
              <button key={p.days} type="button" className="btn btn-secondary btn-sm" onClick={() => setExpiryDays(p.days)}>
                {p.label}
              </button>
            ))}
            <input
              type="datetime-local"
              className="expiry-custom"
              value={expiration ? new Date(expiration * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
              onChange={(e) => {
                const ts = Math.floor(new Date(e.target.value).getTime() / 1000)
                if (ts > Date.now() / 1000) {
                  setExpiration(ts)
                }
              }}
            />
          </div>
        )}
      </div>

      <div className="review-memo">
        <label htmlFor="memo">Memo (optional)</label>
        <p className="memo-warning">
          This memo will be posted publicly onchain and cannot be deleted. Do not include sensitive information.
        </p>
        <textarea
          id="memo"
          placeholder="Add a memo to your offer..."
          value={memo}
          onChange={handleMemoChange}
          rows={6}
        />
        <span className="char-count">{new TextEncoder().encode(memo).length}/280</span>
      </div>

      {isSelf && (
        <p className="form-error">You can't create an offer with yourself.</p>
      )}

      <div className="wizard-footer">
        <div className="wizard-nav">
          <button type="button" className="btn btn-secondary" onClick={back}>Back</button>
          <button type="button" className="btn btn-primary" onClick={next} disabled={isSelf}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
