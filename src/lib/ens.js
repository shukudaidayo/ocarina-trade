import { JsonRpcProvider } from 'ethers'
import { CHAINS } from './constants'

const reverseCache = new Map()
const forwardCache = new Map()

function getMainnetProvider() {
  const chain = CHAINS[1]
  if (!chain) return null
  return new JsonRpcProvider(chain.rpcUrl)
}

/**
 * Resolve an address to an ENS name (reverse lookup).
 * Uses mainnet provider since ENS lives on L1.
 * Returns the ENS name or null.
 */
export async function resolveENS(address) {
  if (!address) return null

  const key = address.toLowerCase()
  if (reverseCache.has(key)) return reverseCache.get(key)

  try {
    const provider = getMainnetProvider()
    if (!provider) return null

    const name = await provider.lookupAddress(address)
    reverseCache.set(key, name)
    return name
  } catch {
    reverseCache.set(key, null)
    return null
  }
}

/**
 * Resolve an ENS name to an address (forward lookup).
 * Returns the address or null.
 */
export async function resolveENSName(name) {
  if (!name || !name.includes('.')) return null

  const key = name.toLowerCase()
  if (forwardCache.has(key)) return forwardCache.get(key)

  try {
    const provider = getMainnetProvider()
    if (!provider) return null

    const address = await provider.resolveName(name)
    forwardCache.set(key, address)
    return address
  } catch {
    forwardCache.set(key, null)
    return null
  }
}
