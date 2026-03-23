import { WHITELISTED_ERC20, CHAINS } from '../../lib/constants'

/**
 * Running tally of selected assets in natural language.
 * "2 Milady Maker, 1 Pudgy Penguin, and 12.34 USDC"
 */
export default function AssetTally({ assets, chainId }) {
  if (!assets || assets.length === 0) return <span className="asset-tally empty">No items selected</span>

  const parts = []

  // Group NFTs by collection
  const nfts = assets.filter((a) => a.assetType === 'ERC721' || a.assetType === 'ERC1155')
  const collections = {}
  for (const nft of nfts) {
    const name = nft._collection || nft._name || truncAddr(nft.token)
    collections[name] = (collections[name] || 0) + 1
  }
  for (const [name, count] of Object.entries(collections)) {
    parts.push(count > 1 ? `${count} ${name}` : name)
  }

  // Cash items
  const cashItems = assets.filter((a) => a.assetType === 'ERC20' || a.assetType === 'NATIVE')
  for (const item of cashItems) {
    if (item.assetType === 'NATIVE') {
      parts.push(`${item.amount} ${CHAINS[chainId]?.nativeSymbol || 'ETH'}`)
    } else {
      const info = (WHITELISTED_ERC20[chainId] || {})[item.token]
      const symbol = item._symbol || info?.symbol || truncAddr(item.token)
      parts.push(`${item.amount} ${symbol}`)
    }
  }

  return <span className="asset-tally">{joinNatural(parts)}</span>
}

function truncAddr(addr) {
  if (!addr) return '?'
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function joinNatural(parts) {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1]
}
