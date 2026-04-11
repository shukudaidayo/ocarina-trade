import { Contract, JsonRpcProvider } from 'ethers'
import { CHAINS, IPFS_GATEWAY } from './constants'

const ALCHEMY_API_KEY = import.meta.env.VITE_ALCHEMY_API_KEY
const ALCHEMY_NETWORKS = { 1: 'eth-mainnet', 8453: 'base-mainnet', 137: 'polygon-mainnet' }

const ERC721_URI_ABI = ['function tokenURI(uint256 tokenId) view returns (string)']
const ERC1155_URI_ABI = ['function uri(uint256 tokenId) view returns (string)']

/**
 * Fetch NFT metadata for a given token.
 * Returns { name, image, description } or null on failure.
 * Caches in sessionStorage.
 */
export async function fetchMetadata(chainId, tokenAddress, tokenId, assetType = 0) {
  chainId = Number(chainId)
  const cacheKey = `nft:${chainId}:${tokenAddress}:${tokenId}`

  // Check cache
  try {
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) return JSON.parse(cached)
  } catch {}

  // Try Alchemy first (pre-cached images, much faster)
  let result = await fetchAlchemyMetadata(chainId, tokenAddress, tokenId)

  // Fall back to on-chain tokenURI if Alchemy unavailable or returned no image
  if (!result?.image) {
    try {
      const uri = await getTokenURI(chainId, tokenAddress, tokenId, assetType)
      if (uri) {
        const resolved = resolveURI(uri)
        const metadata = await fetchJSON(resolved)
        if (metadata) {
          result = {
            name: metadata.name || null,
            image: metadata.image ? resolveURI(metadata.image) : null,
            description: metadata.description || null,
          }
        }
      }
    } catch {}
  }

  if (!result) return null

  // Cache
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify(result))
  } catch {}

  return result
}

/**
 * Call tokenURI (ERC-721) or uri (ERC-1155) on the contract.
 */
async function getTokenURI(chainId, tokenAddress, tokenId, assetType) {
  const chain = CHAINS[chainId]
  if (!chain) return null

  const provider = new JsonRpcProvider(chain.rpcUrl)
  const abi = assetType === 1 ? ERC1155_URI_ABI : ERC721_URI_ABI
  const contract = new Contract(tokenAddress, abi, provider)

  try {
    if (assetType === 1) {
      return await contract.uri(tokenId)
    }
    return await contract.tokenURI(tokenId)
  } catch {
    return null
  }
}

/**
 * Resolve an IPFS, data, or HTTP URI to a fetchable URL.
 */
function resolveURI(uri) {
  if (!uri) return null

  if (uri.startsWith('ipfs://')) {
    return IPFS_GATEWAY + uri.slice(7)
  }

  if (uri.startsWith('data:')) {
    return uri
  }

  if (uri.startsWith('ar://')) {
    return 'https://arweave.net/' + uri.slice(5)
  }

  return uri
}

/**
 * Fetch JSON from a URL, handling data URIs.
 */
async function fetchJSON(url) {
  if (!url) return null

  if (url.startsWith('data:application/json;base64,')) {
    const b64 = url.slice('data:application/json;base64,'.length)
    const raw = atob(b64).replace(/[\x00-\x1f]/g, (ch) => ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : '')
    return JSON.parse(raw)
  }

  if (url.startsWith('data:application/json,')) {
    const json = url.slice('data:application/json,'.length)
    return JSON.parse(decodeURIComponent(json))
  }

  const res = await fetch(url)
  if (!res.ok) return null
  return res.json()
}

/**
 * Fetch NFT metadata from Alchemy's getNFTMetadata endpoint.
 * Used as a fallback when on-chain tokenURI fails.
 */
async function fetchAlchemyMetadata(chainId, tokenAddress, tokenId) {
  if (!ALCHEMY_API_KEY) return null
  const network = ALCHEMY_NETWORKS[chainId]
  if (!network) return null

  try {
    const res = await fetch(
      `https://${network}.g.alchemy.com/nft/v3/${ALCHEMY_API_KEY}/getNFTMetadata?contractAddress=${tokenAddress}&tokenId=${tokenId}`,
    )
    if (!res.ok) return null
    const data = await res.json()
    const image = data.image?.thumbnailUrl || data.image?.cachedUrl || null
    if (!image) return null
    return {
      name: data.name || null,
      image,
      description: data.description || null,
    }
  } catch {
    return null
  }
}
