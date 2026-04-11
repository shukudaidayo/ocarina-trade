import { useState, useEffect } from 'react'
import { fetchMetadata } from '../lib/metadata'
import { getVerificationStatus, getEtherscanUrl } from '../lib/verification'
import { WHITELISTED_ERC20, CHAINS } from '../lib/constants'

const TOKEN_LOGOS = {
  ETH: new URL('../assets/tokens/eth.png', import.meta.url).href,
  POL: new URL('../assets/tokens/pol.png', import.meta.url).href,
  WETH: new URL('../assets/tokens/weth.png', import.meta.url).href,
  USDC: new URL('../assets/tokens/usdc.png', import.meta.url).href,
  USDT: new URL('../assets/tokens/usdt.png', import.meta.url).href,
  USDT0: new URL('../assets/tokens/usdt.png', import.meta.url).href,
  USDS: new URL('../assets/tokens/usds.png', import.meta.url).href,
  EURC: new URL('../assets/tokens/eurc.png', import.meta.url).href,
}

function resolveItemType(asset) {
  if (asset.itemType !== undefined) return Number(asset.itemType)
  if (asset.assetType === 'NATIVE') return 0
  if (asset.assetType === 'ERC20') return 1
  if (asset.assetType === 'ERC1155') return 3
  return 2
}

export default function AssetCard({ asset, chainId, compact = true, showUnverifiedWarning = false }) {
  const [metadata, setMetadata] = useState(null)
  const [loading, setLoading] = useState(true)
  const [verification, setVerification] = useState(null)

  const itemType = resolveItemType(asset)
  const isNative = itemType === 0
  const isERC20 = itemType === 1
  const isERC1155 = itemType === 3
  const isNFT = itemType === 2 || itemType === 3

  // Look up ERC-20 symbol from whitelist
  const erc20Info = isERC20 && chainId ? (WHITELISTED_ERC20[chainId] || {})[asset.token] : null

  useEffect(() => {
    if (!asset.token || !chainId || isERC20 || isNative) {
      setLoading(false)
      return
    }

    // Use cached metadata from the asset picker if available
    if (asset._image) {
      setMetadata({ name: asset._name, image: asset._image })
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
  }, [asset.token, asset.tokenId, itemType, chainId, isERC20, isNative, isERC1155])

  // Fetch verification status (async — may call Alchemy)
  // Whitelisted ERC-20s are always verified — skip the lookup
  useEffect(() => {
    if (!asset.token || !chainId || isNative) return
    if (erc20Info) {
      setVerification({ status: 'verified', message: null })
      return
    }

    let cancelled = false
    getVerificationStatus(chainId, asset.token, metadata?.name).then((v) => {
      if (!cancelled) setVerification(v)
    })

    return () => { cancelled = true }
  }, [asset.token, chainId, isNative, erc20Info, metadata?.name])

  // Native currency — simple display, no verification needed
  const nativeSym = CHAINS[chainId]?.nativeSymbol || 'ETH'
  const nativeLogo = TOKEN_LOGOS[nativeSym]
  const CHAIN_SLUGS = { 1: 'ethereum', 8453: 'base', 137: 'polygon', 57073: 'ink' }
  const chainSlug = CHAIN_SLUGS[chainId] || 'ethereum'
  if (isNative) {
    const nativeSwapUrl = chainId === 57073
      ? `https://velodrome.finance/swap?to=eth&chain1=57073`
      : `https://app.uniswap.org/swap?chain=${chainSlug}&outputCurrency=NATIVE`
    const nativeSwapLabel = chainId === 57073 ? 'Buy on Velodrome' : 'Buy on Uniswap'
    return (
      <div className={`asset-card asset-card-verified${!compact ? ' asset-card-large asset-card-cash' : ''}`}>
        <div className="asset-card-image">
          {nativeLogo ? (
            <img src={nativeLogo} alt={nativeSym} />
          ) : (
            <div className="asset-card-placeholder">{nativeSym}</div>
          )}
        </div>
        <div className="asset-card-info">
          <span className="asset-card-name">{asset.amount || '0'} {nativeSym}</span>
          {!compact && (
            <div className="asset-card-links">
              <a href={nativeSwapUrl} target="_blank" rel="noopener noreferrer" className="btn-link btn-sm">
                {nativeSwapLabel}
              </a>
            </div>
          )}
        </div>
      </div>
    )
  }

  const vStatus = verification || { status: 'unverified', message: null }
  const etherscanUrl = getEtherscanUrl(chainId, asset.token)

  // Display name for ERC-20
  const displayName = isERC20
    ? `${asset.amount || '0'} ${erc20Info?.symbol || 'tokens'}`
    : metadata?.name || `#${asset.tokenId}`

  const openseaUrl = isNFT ? `https://opensea.io/assets/${
    { 1: 'ethereum', 8453: 'base', 137: 'matic', 57073: 'ink' }[chainId] || 'ethereum'
  }/${asset.token}/${asset.tokenId}` : null

  const swapUrl = isERC20
    ? chainId === 57073
      ? `https://velodrome.finance/swap?to=${asset.token}&chain1=57073`
      : `https://app.uniswap.org/swap?chain=${chainSlug}&outputCurrency=${asset.token}`
    : null
  const swapLabel = chainId === 57073 ? 'Buy on Velodrome' : 'Buy on Uniswap'

  return (
    <div className={`asset-card asset-card-${vStatus.status}${!compact ? ' asset-card-large' : ''}${!compact && isERC20 ? ' asset-card-cash' : ''}`}>
      <div className="asset-card-image">
        {isERC20 ? (
          erc20Info && TOKEN_LOGOS[erc20Info.symbol]
            ? <img src={TOKEN_LOGOS[erc20Info.symbol]} alt={erc20Info.symbol} />
            : <div className="asset-card-placeholder">$</div>
        ) : loading ? (
          <div className="asset-card-placeholder">...</div>
        ) : metadata?.image ? (
          <img src={metadata.image} alt={metadata.name || ''} loading="lazy" />
        ) : (
          <div className="asset-card-placeholder">?</div>
        )}
        {isNFT && vStatus.status === 'verified' && (
          <span className="asset-card-verified-badge" title="Verified">&#10003;</span>
        )}
      </div>
      <div className="asset-card-info">
        <span className="asset-card-name" title={displayName}>
          {displayName}
          {isERC1155 && <span className="asset-detail"> &times;{asset.amount}</span>}
        </span>
        {compact ? (
          <>
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
              <span className="asset-type">{{ 0: nativeSym, 1: 'ERC-20', 2: 'ERC-721', 3: 'ERC-1155' }[itemType] || 'Unknown'}</span>
              {isNFT && <span className="asset-card-tokenid">#{asset.tokenId}</span>}
            </div>
          </>
        ) : (
          <div className="asset-card-links">
            {openseaUrl && (
              <a href={openseaUrl} target="_blank" rel="noopener noreferrer" className="btn-link btn-sm">
                View on OpenSea
              </a>
            )}
            {swapUrl && (
              <a href={swapUrl} target="_blank" rel="noopener noreferrer" className="btn-link btn-sm">
                {swapLabel}
              </a>
            )}
          </div>
        )}
        {showUnverifiedWarning && isNFT && vStatus.status !== 'verified' && (
          <div className="asset-card-warning">
            Unverified asset: review on{' '}
            {openseaUrl ? <a href={openseaUrl} target="_blank" rel="noopener noreferrer">OpenSea</a> : 'OpenSea'}{' '}
            to confirm that this is the intended asset.
          </div>
        )}
      </div>
    </div>
  )
}
