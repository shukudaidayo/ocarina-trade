import { useState, useEffect } from 'react'
import { fetchMetadata } from '../lib/metadata'
import { getVerificationStatus, getEtherscanUrl } from '../lib/verification'

// Seaport ItemType enum values
const ITEM_TYPE_LABELS = { 1: 'ERC-20', 2: 'ERC-721', 3: 'ERC-1155' }
const BADGE = { verified: '\u2705', unverified: '\u26A0\uFE0F', suspicious: '\uD83D\uDED1' }

export default function AssetCard({ asset, chainId }) {
  const [metadata, setMetadata] = useState(null)
  const [loading, setLoading] = useState(true)

  const itemType = asset.itemType ?? (asset.assetType === 'ERC1155' ? 3 : asset.assetType === 'ERC20' ? 1 : 2)
  const isERC20 = itemType === 1
  const isERC1155 = itemType === 3

  useEffect(() => {
    if (!asset.token || !chainId || isERC20) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setMetadata(null)

    fetchMetadata(chainId, asset.token, asset.tokenId, isERC1155 ? 1 : 0)
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
  }, [asset.token, asset.tokenId, itemType, chainId, isERC20, isERC1155])

  const verification = getVerificationStatus(chainId, asset.token, metadata?.name)
  const etherscanUrl = getEtherscanUrl(chainId, asset.token)

  return (
    <div className={`asset-card asset-card-${verification.status}`}>
      <div className="asset-card-image">
        {isERC20 ? (
          <div className="asset-card-placeholder">$</div>
        ) : loading ? (
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
          {isERC20 ? `${asset.amount} tokens` : metadata?.name || `#${asset.tokenId}`}
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
          <span className="asset-type">{ITEM_TYPE_LABELS[itemType] || 'Unknown'}</span>
          {isERC1155 && (
            <span className="asset-detail">&times;{asset.amount}</span>
          )}
          {!isERC20 && <span className="asset-card-tokenid">#{asset.tokenId}</span>}
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
