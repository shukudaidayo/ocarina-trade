import { CHAINS } from './constants'

const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY

const CHAIN_NETWORKS = {
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  137: 'polygon-mainnet',
}

// Chains where Alchemy NFT API isn't available — use Blockscout v2 instead
function blockscoutApi(chainId) {
  if (CHAIN_NETWORKS[chainId]) return null
  return CHAINS[chainId]?.blockscoutApi?.replace(/\/api\/?$/, '/api/v2') || null
}

/**
 * Fetch collections (contracts) owned by an address using getContractsForOwner.
 * Returns { collections: [...], pageKey: string|null, totalCount: number }
 * Each collection: { address, name, tokenType, numDistinctTokensOwned, totalBalance,
 *                    isSpam, safelistStatus, image, collectionImage }
 */
export async function fetchCollections(address, chainId, pageKey = null) {
  const bsApi = blockscoutApi(chainId)
  if (bsApi) return fetchCollectionsBlockscout(bsApi, address, pageKey)

  if (!ALCHEMY_API_KEY) throw new Error('VITE_ALCHEMY_API_KEY not set')

  const network = CHAIN_NETWORKS[chainId]
  if (!network) throw new Error(`Unsupported chain: ${chainId}`)

  let url = `https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}/getContractsForOwner?owner=${address}&withMetadata=true&pageSize=50&orderBy=transferTime`
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
 * Fetch a page of NFTs owned by an address for a specific contract.
 * Returns { nfts: [...], pageKey: string|null }
 */
export async function fetchNFTsForContract(address, chainId, contractAddress, pageKey = null) {
  const bsApi = blockscoutApi(chainId)
  if (bsApi) return fetchNFTsForContractBlockscout(bsApi, address, contractAddress, pageKey)

  if (!ALCHEMY_API_KEY) return { nfts: [], pageKey: null }

  const network = CHAIN_NETWORKS[chainId]
  if (!network) return { nfts: [], pageKey: null }

  let url = `https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}/getNFTsForOwner?owner=${address}&withMetadata=true&pageSize=100&contractAddresses[]=${contractAddress}`
  if (pageKey) url += `&pageKey=${encodeURIComponent(pageKey)}`

  const res = await fetch(url)
  if (!res.ok) return { nfts: [], pageKey: null }

  const data = await res.json()
  const nfts = (data.ownedNfts || []).map((nft) => ({
    contract: nft.contract?.address,
    contractName: nft.collection?.name || nft.contract?.openSeaMetadata?.collectionName || nft.contract?.name || '',
    tokenType: nft.tokenType || nft.contract?.tokenType || 'ERC721',
    tokenId: nft.tokenId,
    name: nft.name || `#${nft.tokenId}`,
    image: nft.image?.thumbnailUrl || nft.image?.cachedUrl || null,
    balance: String(nft.balance ?? '1'),
    isSpam: nft.contract?.isSpam || false,
    safelistStatus: nft.contract?.openSeaMetadata?.safelistRequestStatus || null,
  }))

  return { nfts, pageKey: data.pageKey || null }
}

// --- Blockscout v2 fallback for chains without Alchemy NFT API ---

async function fetchCollectionsBlockscout(apiBase, address, pageKey = null) {
  let url = `${apiBase}/addresses/${address}/nft/collections?type=ERC-721%2CERC-1155`
  if (pageKey) {
    const params = JSON.parse(pageKey)
    const qs = new URLSearchParams(params).toString()
    url += `&${qs}`
  }

  const res = await fetch(url)
  if (!res.ok) return { collections: [], pageKey: null, totalCount: 0 }

  const data = await res.json()
  const collections = (data.items || []).map((item) => {
    const firstInstance = item.token_instances?.[0]
    const image = item.token?.icon_url || firstInstance?.image_url || null
    return {
      address: item.token?.address_hash,
      name: item.token?.name || '',
      tokenType: (item.token?.type || 'ERC-721').replace('-', ''),
      numDistinctTokensOwned: String(item.token_instances?.length || item.amount || '0'),
      totalBalance: String(item.amount || '0'),
      isSpam: false,
      safelistStatus: null,
      image,
      collectionImage: image,
    }
  })

  const nextKey = data.next_page_params ? JSON.stringify(data.next_page_params) : null
  return { collections, pageKey: nextKey, totalCount: collections.length }
}

async function fetchNFTsForContractBlockscout(apiBase, address, contractAddress, pageKey = null) {
  let url = `${apiBase}/tokens/${contractAddress}/instances?holder_address_hash=${address}`
  if (pageKey) {
    const params = JSON.parse(pageKey)
    const qs = new URLSearchParams(params).toString()
    url += `&${qs}`
  }

  const res = await fetch(url)
  if (!res.ok) return { nfts: [], pageKey: null }

  const data = await res.json()
  const nfts = (data.items || []).map((inst) => ({
    contract: contractAddress,
    contractName: inst.token?.name || '',
    tokenType: (inst.token_type || inst.token?.type || 'ERC-721').replace('-', ''),
    tokenId: inst.id,
    name: inst.metadata?.name || `#${inst.id}`,
    image: inst.image_url || inst.metadata?.image || null,
    balance: String(inst.value ?? '1'),
    isSpam: false,
    safelistStatus: null,
  }))

  const nextKey = data.next_page_params ? JSON.stringify(data.next_page_params) : null
  return { nfts, pageKey: nextKey }
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
