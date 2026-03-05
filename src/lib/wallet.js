import { BrowserProvider } from 'ethers'

const STORAGE_KEY = 'otcswap:wallet'

/**
 * Discover wallets via EIP-6963, with window.ethereum fallback.
 * Returns a promise that resolves with an array of provider details.
 */
export function discoverWallets(timeoutMs = 500) {
  return new Promise((resolve) => {
    const wallets = []

    function onAnnounce(event) {
      const { info, provider } = event.detail
      // Deduplicate by rdns
      if (!wallets.some((w) => w.info.rdns === info.rdns)) {
        wallets.push({ info, provider })
      }
    }

    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)

      // Fallback: if no EIP-6963 wallets found, check window.ethereum
      if (wallets.length === 0 && window.ethereum) {
        wallets.push({
          info: {
            uuid: 'injected',
            name: 'Browser Wallet',
            icon: null,
            rdns: 'injected',
          },
          provider: window.ethereum,
        })
      }

      resolve(wallets)
    }, timeoutMs)
  })
}

/**
 * Request accounts from a provider and return the connected address.
 */
export async function connectWallet(provider) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  if (!accounts || accounts.length === 0) {
    throw new Error('No accounts returned')
  }
  return accounts[0]
}

/**
 * Get an ethers BrowserProvider wrapping the raw EIP-1193 provider.
 */
export function getEthersProvider(rawProvider) {
  return new BrowserProvider(rawProvider)
}

/**
 * Get current chain ID from provider.
 */
export async function getChainId(provider) {
  const chainId = await provider.request({ method: 'eth_chainId' })
  return parseInt(chainId, 16)
}

/**
 * Save wallet preference to localStorage.
 */
export function saveWalletPreference(rdns) {
  try {
    localStorage.setItem(STORAGE_KEY, rdns)
  } catch {}
}

/**
 * Load saved wallet preference.
 */
export function loadWalletPreference() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Clear saved wallet preference.
 */
export function clearWalletPreference() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

/**
 * Truncate address for display: 0x1234...abcd
 */
export function truncateAddress(address) {
  return address.slice(0, 6) + '...' + address.slice(-4)
}
