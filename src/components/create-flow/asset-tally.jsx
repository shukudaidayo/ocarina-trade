import { WHITELISTED_ERC20, CHAINS } from '../../lib/constants'

/**
 * Running tally of selected assets, each removable via × button.
 */
export default function AssetTally({ assets, chainId, onChange }) {
  if (!assets || assets.length === 0) return <span className="asset-tally empty">No items selected</span>

  const remove = (index) => {
    if (!onChange) return
    onChange(assets.filter((_, i) => i !== index))
  }

  return (
    <span className="asset-tally">
      {assets.map((asset, i) => (
        <span key={i} className="asset-tally-item">
          {describeAsset(asset, chainId)}
          {onChange && (
            <button type="button" className="asset-tally-remove" onClick={() => remove(i)} title="Remove">&times;</button>
          )}
        </span>
      ))}
    </span>
  )
}

function describeAsset(asset, chainId) {
  if (asset.assetType === 'NATIVE') {
    return `${asset.amount} ${CHAINS[chainId]?.nativeSymbol || 'ETH'}`
  }
  if (asset.assetType === 'ERC20') {
    const info = (WHITELISTED_ERC20[chainId] || {})[asset.token]
    const symbol = asset._symbol || info?.symbol || truncAddr(asset.token)
    return `${asset.amount} ${symbol}`
  }
  const name = asset._collection || asset._name || truncAddr(asset.token)
  const amount = asset.assetType === 'ERC1155' && Number(asset.amount) > 1 ? `${asset.amount}× ` : ''
  return `${amount}${name}`
}

function truncAddr(addr) {
  if (!addr) return '?'
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}
