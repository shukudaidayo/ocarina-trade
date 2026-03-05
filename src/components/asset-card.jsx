import { useState, useEffect } from 'react'
import { fetchMetadata } from '../lib/metadata'
import { getVerificationStatus, getEtherscanUrl } from '../lib/verification'

const ASSET_TYPE_LABELS = ['ERC-721', 'ERC-1155']
const BADGE = { verified: '\u2705', unverified: '\u26A0\uFE0F', suspicious: '\uD83D\uDED1' }

export default function AssetCard({ asset, chainId }) {
  const [metadata, setMetadata] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!asset.token || !chainId) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setMetadata(null)

    fetchMetadata(chainId, asset.token, asset.tokenId, asset.assetType)
      .then((m) => {
        if (!cancelled) {
          setMetadata(m)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [asset.token, asset.tokenId, asset.assetType, chainId])

  const verification = getVerificationStatus(chainId, asset.token, metadata?.name)
  const etherscanUrl = getEtherscanUrl(chainId, asset.token)

  return (
    <div className={`asset-card asset-card-${verification.status}`}>
      <div className="asset-card-image">
        {loading ? (
          <div className="asset-card-placeholder">...</div>
        ) : metadata?.image ? (
          <img src={metadata.image} alt={metadata.name || ''} loading="lazy" />
        ) : (
          <div className="asset-card-placeholder">?</div>
        )}
      </div>
      <div className="asset-card-info">
        <span className="asset-card-name">
          <span className="verification-badge" title={verification.status}>
            {BADGE[verification.status]}
          </span>
          {metadata?.name || `#${asset.tokenId}`}
        </span>
        <a
          className="asset-card-address"
          href={etherscanUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="View on Etherscan"
        >
          {asset.token}
        </a>
        <div className="asset-card-meta">
          <span className="asset-type">{ASSET_TYPE_LABELS[asset.assetType]}</span>
          {asset.assetType === 1 && (
            <span className="asset-detail">&times;{asset.amount}</span>
          )}
          <span className="asset-card-tokenid">#{asset.tokenId}</span>
        </div>
        {verification.status !== 'verified' && verification.message && (
          <p className={`verification-msg verification-${verification.status}`}>
            {verification.message}
          </p>
        )}
      </div>
    </div>
  )
}
