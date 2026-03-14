const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY

const CHAIN_NETWORKS = {
  1: 'eth-mainnet',
  11155111: 'eth-sepolia',
}

/**
 * Fetch NFTs owned by an address using the Alchemy Portfolio API.
 * Returns { nfts: [...], pageKey: string|null }
 */
export async function fetchWalletNFTs(address, chainId, pageKey = null) {
  if (!ALCHEMY_API_KEY) {
    throw new Error('VITE_ALCHEMY_API_KEY not set')
  }

  const network = CHAIN_NETWORKS[chainId]
  if (!network) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }

  const body = {
    addresses: [{ address, networks: [network] }],
    excludeFilters: ['SPAM'],
    withMetadata: true,
    pageSize: 100,
  }
  if (pageKey) body.pageKey = pageKey

  const res = await fetch(
    `https://api.g.alchemy.com/data/v1/${ALCHEMY_API_KEY}/assets/nfts/by-address`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )

  if (!res.ok) {
    throw new Error(`Alchemy API error: ${res.status}`)
  }

  const data = await res.json()
  const raw = data.data?.ownedNfts || []
  const nfts = raw.map((nft) => ({
    contract: nft.contract?.address,
    contractName: nft.contract?.name || '',
    tokenType: nft.tokenType || nft.contract?.tokenType || 'ERC721',
    tokenId: nft.tokenId,
    name: nft.name || `#${nft.tokenId}`,
    image: nft.image?.thumbnailUrl || nft.image?.cachedUrl || null,
    balance: String(nft.balance ?? nft.amount ?? '1'),
  }))

  return { nfts, pageKey: data.data?.pageKey || null }
}
