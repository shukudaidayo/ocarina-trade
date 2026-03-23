import { WHITELISTED_ERC20, CHAINS } from '../lib/constants'
import AssetCard from './asset-card'

const ASSET_TYPES_OFFER = [
  { value: 'ERC721', label: 'ERC-721' },
  { value: 'ERC1155', label: 'ERC-1155' },
  { value: 'ERC20', label: 'ERC-20' },
]

export default function AssetInput({ asset, onChange, onRemove, chainId, side = 'offer' }) {
  const nativeSym = CHAINS[chainId]?.nativeSymbol || 'ETH'

  const ASSET_TYPES_CONSIDERATION = [
    { value: 'ERC721', label: 'ERC-721' },
    { value: 'ERC1155', label: 'ERC-1155' },
    { value: 'ERC20', label: 'ERC-20' },
    { value: 'NATIVE', label: nativeSym },
  ]
  const isERC20 = asset.assetType === 'ERC20'
  const isNative = asset.assetType === 'NATIVE'
  const isERC1155 = asset.assetType === 'ERC1155'
  const showTokenId = !isERC20 && !isNative
  const showAmount = isERC20 || isNative || isERC1155

  const whitelisted = chainId ? WHITELISTED_ERC20[chainId] || {} : {}
  const tokenEntries = Object.entries(whitelisted)

  // For preview: need valid address + token ID for NFTs, or valid token for ERC-20/ETH
  const hasValidAddress = /^0x[0-9a-fA-F]{40}$/.test(asset.token)
  const hasTokenId = asset.tokenId !== '' && asset.tokenId !== undefined
  const showPreview = isNative
    ? !!asset.amount
    : isERC20
      ? hasValidAddress && !!asset.amount
      : hasValidAddress && hasTokenId

  return (
    <div className="asset-input">
      <div className="asset-input-row">
        <select
          value={asset.assetType}
          onChange={(e) => {
            const newType = e.target.value
            if (newType === 'NATIVE') {
              onChange({ ...asset, assetType: newType, token: '', tokenId: '', amount: '' })
            } else if (newType === 'ERC20') {
              const firstToken = tokenEntries.length > 0 ? tokenEntries[0][0] : ''
              onChange({ ...asset, assetType: newType, token: firstToken, tokenId: '', amount: '' })
            } else {
              onChange({ ...asset, assetType: newType, amount: newType === 'ERC1155' ? '1' : '1' })
            }
          }}
        >
          {(side === 'consideration' ? ASSET_TYPES_CONSIDERATION : ASSET_TYPES_OFFER).map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button className="btn-remove" onClick={onRemove} type="button">&times;</button>
      </div>

      {isNative && (
        <div className="asset-input-row">
          <input
            type="text"
            placeholder={`Amount (${nativeSym})`}
            value={asset.amount}
            onChange={(e) => onChange({ ...asset, amount: e.target.value })}
          />
        </div>
      )}

      {isERC20 && (
        <div className="asset-input-row">
          <select
            value={asset.token}
            onChange={(e) => onChange({ ...asset, token: e.target.value })}
          >
            {tokenEntries.length === 0 && <option value="">No tokens on this chain</option>}
            {tokenEntries.map(([addr, info]) => (
              <option key={addr} value={addr}>{info.symbol}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Amount"
            value={asset.amount}
            onChange={(e) => onChange({ ...asset, amount: e.target.value })}
          />
        </div>
      )}

      {!isERC20 && !isNative && (
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
      )}

      {isERC1155 && (
        <div className="asset-input-row">
          <input
            type="text"
            placeholder="Amount"
            value={asset.amount}
            onChange={(e) => onChange({ ...asset, amount: e.target.value })}
          />
        </div>
      )}

      {showPreview && chainId && (
        <div className="asset-input-preview">
          <AssetCard asset={asset} chainId={chainId} />
        </div>
      )}
    </div>
  )
}
