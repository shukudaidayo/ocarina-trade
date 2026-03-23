const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY

const CHAIN_NETWORKS = {
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  137: 'polygon-mainnet',
}

/**
 * Fetch collections (contracts) owned by an address using getContractsForOwner.
 * Returns { collections: [...], pageKey: string|null, totalCount: number }
 * Each collection: { address, name, tokenType, numDistinctTokensOwned, totalBalance,
 *                    isSpam, safelistStatus, image, collectionImage }
 */
export async function fetchCollections(address, chainId, pageKey = null) {
  if (!ALCHEMY_API_KEY) throw new Error('VITE_ALCHEMY_API_KEY not set')

  const network = CHAIN_NETWORKS[chainId]
  if (!network) throw new Error(`Unsupported chain: ${chainId}`)

  let url = `https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}/getContractsForOwner?owner=${address}&withMetadata=true&pageSize=50`
  if (pageKey) url += `&pageKey=${encodeURIComponent(pageKey)}`

  const res = await fetch(url)

  if (!res.ok && (res.status === 400 || res.status === 403)) {
    if (pageKey) return { collections: [], pageKey: null, totalCount: 0 }
    return { collections: [], pageKey: null, totalCount: 0 }
  } else if (!res.ok) {
    throw new Error(`Alchemy API error: ${res.status}`)
  }

  const data = await res.json()
  const raw = data.contracts || []
  const collections = raw.map((c) => ({
    address: c.address,
    name: c.openSeaMetadata?.collectionName || c.name || '',
    tokenType: c.tokenType || 'ERC721',
    numDistinctTokensOwned: c.numDistinctTokensOwned || '0',
    totalBalance: c.totalBalance || '0',
    isSpam: c.isSpam || false,
    safelistStatus: c.openSeaMetadata?.safelistRequestStatus || null,
    image: c.image?.thumbnailUrl || c.image?.cachedUrl || null,
    collectionImage: c.openSeaMetadata?.imageUrl || null,
  }))

  return { collections, pageKey: data.pageKey || null, totalCount: data.totalCount || 0 }
}

/**
 * Fetch all NFTs owned by an address for a specific contract.
 * Pages through all results automatically.
 */
export async function fetchNFTsForContract(address, chainId, contractAddress) {
  if (!ALCHEMY_API_KEY) return []

  const network = CHAIN_NETWORKS[chainId]
  if (!network) return []

  let allNfts = []
  let pageKey = null

  do {
    let url = `https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}/getNFTsForOwner?owner=${address}&withMetadata=true&pageSize=100&contractAddresses[]=${contractAddress}`
    if (pageKey) url += `&pageKey=${encodeURIComponent(pageKey)}`

    const res = await fetch(url)
    if (!res.ok) break

    const data = await res.json()
    const raw = data.ownedNfts || []
    allNfts.push(...raw.map((nft) => ({
      contract: nft.contract?.address,
      contractName: nft.collection?.name || nft.contract?.openSeaMetadata?.collectionName || nft.contract?.name || '',
      tokenType: nft.tokenType || nft.contract?.tokenType || 'ERC721',
      tokenId: nft.tokenId,
      name: nft.name || `#${nft.tokenId}`,
      image: nft.image?.thumbnailUrl || nft.image?.cachedUrl || null,
      balance: String(nft.balance ?? '1'),
      isSpam: nft.contract?.isSpam || false,
      safelistStatus: nft.contract?.openSeaMetadata?.safelistRequestStatus || null,
    })))
    pageKey = data.pageKey || null
  } while (pageKey)

  return allNfts
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
