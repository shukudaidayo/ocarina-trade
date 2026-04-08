import { JsonRpcProvider, Contract } from 'ethers'
import { CHAINS } from './constants'

const reverseCache = new Map()
const forwardCache = new Map()

const WEI_NAMES_ADDRESS = '0x0000000000696760E15f265e828DB644A0c242EB'
const WEI_NAMES_ABI = [
  'function computeId(string fullName) public pure returns (uint256)',
  'function resolve(uint256 tokenId) public view returns (address)',
  'function reverseResolve(address addr) public view returns (string)',
]

function getMainnetProvider() {
  const chain = CHAINS[1]
  if (!chain) return null
  return new JsonRpcProvider(chain.rpcUrl)
}

function getWeiContract(provider) {
  return new Contract(WEI_NAMES_ADDRESS, WEI_NAMES_ABI, provider)
}

/**
 * Resolve an address to a name (reverse lookup).
 * Tries ENS first, falls back to .wei names.
 * Returns the name or null.
 */
export async function resolveENS(address) {
  if (!address) return null

  const key = address.toLowerCase()
  if (reverseCache.has(key)) return reverseCache.get(key)

  try {
    const provider = getMainnetProvider()
    if (!provider) return null

    // Try ENS first
    const ensName = await provider.lookupAddress(address)
    if (ensName) {
      reverseCache.set(key, ensName)
      return ensName
    }

    // Fall back to .wei
    const wei = getWeiContract(provider)
    const weiName = await wei.reverseResolve(address)
    const result = weiName || null
    reverseCache.set(key, result)
    return result
  } catch {
    reverseCache.set(key, null)
    return null
  }
}

/**
 * Resolve a name to an address (forward lookup).
 * Routes .wei names to the wei contract, everything else to ENS.
 * Returns the address or null.
 */
export async function resolveENSName(name) {
  if (!name || !name.includes('.')) return null

  const key = name.toLowerCase()
  if (forwardCache.has(key)) return forwardCache.get(key)

  try {
    const provider = getMainnetProvider()
    if (!provider) return null

    let address = null
    if (key.endsWith('.wei')) {
      const wei = getWeiContract(provider)
      const tokenId = await wei.computeId(key)
      const resolved = await wei.resolve(tokenId)
      if (resolved && resolved !== '0x0000000000000000000000000000000000000000') {
        address = resolved
      }
    } else {
      address = await provider.resolveName(name)
    }

    forwardCache.set(key, address)
    return address
  } catch {
    forwardCache.set(key, null)
    return null
  }
}
