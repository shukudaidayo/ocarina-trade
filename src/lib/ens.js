import { JsonRpcProvider } from 'ethers'
import { CHAINS } from './constants'

const cache = new Map()

/**
 * Resolve an address to an ENS name.
 * Uses mainnet provider since ENS lives on L1.
 * Returns the ENS name or null.
 */
export async function resolveENS(address) {
  if (!address) return null

  const key = address.toLowerCase()
  if (cache.has(key)) return cache.get(key)

  try {
    const chain = CHAINS[1]
    if (!chain) return null

    const provider = new JsonRpcProvider(chain.rpcUrl)
    const name = await provider.lookupAddress(address)
    cache.set(key, name)
    return name
  } catch {
    cache.set(key, null)
    return null
  }
}
