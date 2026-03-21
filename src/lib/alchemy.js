const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY

const CHAIN_NETWORKS = {
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  137: 'polygon-mainnet',
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

// Cache contract metadata to avoid repeated API calls
const contractMetadataCache = new Map()

/**
 * Fetch contract metadata from Alchemy's NFT API.
 * Returns the openseaMetadata.safelistRequestStatus or null.
 */
export async function fetchContractVerification(chainId, contractAddress) {
  const key = `${chainId}:${contractAddress.toLowerCase()}`
  if (contractMetadataCache.has(key)) return contractMetadataCache.get(key)

  if (!ALCHEMY_API_KEY) return null

  const network = CHAIN_NETWORKS[chainId]
  if (!network) return null

  try {
    const res = await fetch(
      `https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}/getContractMetadata?contractAddress=${contractAddress}`,
    )
    if (!res.ok) {
      contractMetadataCache.set(key, null)
      return null
    }

    const data = await res.json()
    const status = data.openSeaMetadata?.safelistRequestStatus
      || data.openseaMetadata?.safelistRequestStatus
      || null
    contractMetadataCache.set(key, status)
    return status
  } catch {
    contractMetadataCache.set(key, null)
    return null
  }
}
