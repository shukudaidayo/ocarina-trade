import AssetCard from './asset-card'

const ASSET_TYPES = [
  { value: 'ERC721', label: 'ERC-721' },
  { value: 'ERC1155', label: 'ERC-1155' },
]

export default function AssetInput({ asset, onChange, onRemove, chainId }) {
  const hasValidAddress = /^0x[0-9a-fA-F]{40}$/.test(asset.token)
  const hasTokenId = asset.tokenId !== '' && asset.tokenId !== undefined
  const isERC1155 = asset.assetType === 'ERC1155'

  return (
    <div className="asset-input">
      <div className="asset-input-row">
        <input
          type="text"
          placeholder="Contract address (0x...)"
          value={asset.token}
          onChange={(e) => onChange({ ...asset, token: e.target.value })}
          spellCheck={false}
        />
        <input
          type="text"
          placeholder="Token ID"
          value={asset.tokenId}
          onChange={(e) => onChange({ ...asset, tokenId: e.target.value })}
        />
      </div>
      <div className="asset-input-row">
        <select
          value={asset.assetType}
          onChange={(e) => onChange({ ...asset, assetType: e.target.value })}
        >
          {ASSET_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {isERC1155 && (
          <input
            type="text"
            placeholder="Amount"
            value={asset.amount}
            onChange={(e) => onChange({ ...asset, amount: e.target.value })}
          />
        )}
        <button className="btn-remove" onClick={onRemove} type="button">&times;</button>
      </div>
      {hasValidAddress && hasTokenId && chainId && (
        <div className="asset-input-preview">
          <AssetCard asset={asset} chainId={chainId} />
        </div>
      )}
    </div>
  )
}
