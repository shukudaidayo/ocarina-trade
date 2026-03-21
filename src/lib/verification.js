import verifiedTokens from '../data/verified-tokens.json'
import { fetchContractVerification } from './alchemy'

// Index verified tokens by name/symbol (lowercased) for impostor detection
const nameIndex = {}
for (const [chainId, tokens] of Object.entries(verifiedTokens)) {
  nameIndex[chainId] = {}
  for (const [address, info] of Object.entries(tokens)) {
    const key = info.name.toLowerCase()
    nameIndex[chainId][key] = address
    if (info.symbol) {
      nameIndex[chainId][info.symbol.toLowerCase()] = address
    }
  }
}

// OpenSea safelist statuses that count as verified
const VERIFIED_STATUSES = new Set(['verified', 'approved'])

/**
 * Check verification status of a token (async — queries Alchemy for OpenSea verification).
 * Falls back to static verified-tokens.json if Alchemy is unavailable.
 * Returns: { status: 'verified' | 'unverified' | 'suspicious', info, message }
 */
export async function getVerificationStatus(chainId, tokenAddress, metadataName) {
  const chainTokens = verifiedTokens[String(chainId)] || {}
  const normalized = tokenAddress.toLowerCase()

  // Check static list first (instant, no API call)
  for (const [addr, info] of Object.entries(chainTokens)) {
    if (addr.toLowerCase() === normalized) {
      return { status: 'verified', info, message: null }
    }
  }

  // Check Alchemy for OpenSea verification status
  const safelistStatus = await fetchContractVerification(chainId, tokenAddress)
  if (safelistStatus && VERIFIED_STATUSES.has(safelistStatus)) {
    return { status: 'verified', info: null, message: null }
  }

  // Check for impostor: metadata name matches a verified token but address differs
  if (metadataName) {
    const chainNames = nameIndex[String(chainId)] || {}
    const nameLower = metadataName.toLowerCase()
    const verifiedAddr = chainNames[nameLower]
    if (verifiedAddr && verifiedAddr.toLowerCase() !== normalized) {
      const verifiedInfo = chainTokens[verifiedAddr]
      return {
        status: 'suspicious',
        info: null,
        message: `WARNING: This token claims to be "${verifiedInfo.name}" but has a different contract address than the verified collection. This is likely a scam.`,
        verifiedAddress: verifiedAddr,
      }
    }
  }

  return {
    status: 'unverified',
    info: null,
    message: 'This token contract is not recognized. Verify the contract address on Etherscan before accepting.',
  }
}

/**
 * Get the Etherscan URL for a contract address on a given chain.
 */
export function getEtherscanUrl(chainId, address) {
  const explorers = {
    1: 'https://etherscan.io',
    8453: 'https://basescan.org',
    137: 'https://polygonscan.com',
  }
  const base = explorers[chainId] || explorers[1]
  return `${base}/address/${address}`
}
