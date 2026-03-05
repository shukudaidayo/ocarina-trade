import { useState, useEffect, useCallback } from 'react'
import {
  discoverWallets,
  connectWallet,
  getChainId,
  saveWalletPreference,
  loadWalletPreference,
  clearWalletPreference,
  truncateAddress,
} from '../lib/wallet'
import { resolveENS } from '../lib/ens'

export default function WalletButton({ onConnect, onDisconnect }) {
  const [wallets, setWallets] = useState([])
  const [address, setAddress] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [activeProvider, setActiveProvider] = useState(null)
  const [ensName, setEnsName] = useState(null)
  const [error, setError] = useState(null)

  // Discover wallets on mount
  useEffect(() => {
    discoverWallets().then(setWallets)
  }, [])

  // Auto-reconnect to previously connected wallet
  useEffect(() => {
    if (wallets.length === 0) return
    const saved = loadWalletPreference()
    if (!saved) return

    const wallet = wallets.find((w) => w.info.rdns === saved)
    if (!wallet) return

    // Try to get already-connected accounts (no popup)
    wallet.provider
      .request({ method: 'eth_accounts' })
      .then(async (accounts) => {
        if (accounts && accounts.length > 0) {
          const chain = await getChainId(wallet.provider)
          setAddress(accounts[0])
          setChainId(chain)
          setActiveProvider(wallet.provider)
          onConnect?.(accounts[0], wallet.provider, chain)
        }
      })
      .catch(() => {})
  }, [wallets])

  // Resolve ENS when address changes
  useEffect(() => {
    if (!address) {
      setEnsName(null)
      return
    }
    let cancelled = false
    resolveENS(address).then((name) => {
      if (!cancelled) setEnsName(name)
    })
    return () => { cancelled = true }
  }, [address])

  // Listen for account and chain changes
  useEffect(() => {
    if (!activeProvider) return

    function handleAccountsChanged(accounts) {
      if (accounts.length === 0) {
        disconnect()
      } else {
        setAddress(accounts[0])
        onConnect?.(accounts[0], activeProvider, chainId)
      }
    }

    function handleChainChanged(chainIdHex) {
      const newChainId = parseInt(chainIdHex, 16)
      setChainId(newChainId)
      onConnect?.(address, activeProvider, newChainId)
    }

    activeProvider.on?.('accountsChanged', handleAccountsChanged)
    activeProvider.on?.('chainChanged', handleChainChanged)

    return () => {
      activeProvider.removeListener?.('accountsChanged', handleAccountsChanged)
      activeProvider.removeListener?.('chainChanged', handleChainChanged)
    }
  }, [activeProvider, address, chainId])

  const handleConnect = useCallback(
    async (wallet) => {
      setError(null)
      try {
        const account = await connectWallet(wallet.provider)
        const chain = await getChainId(wallet.provider)
        setAddress(account)
        setChainId(chain)
        setActiveProvider(wallet.provider)
        saveWalletPreference(wallet.info.rdns)
        setShowModal(false)
        onConnect?.(account, wallet.provider, chain)
      } catch (err) {
        setError(err.message || 'Failed to connect')
      }
    },
    [onConnect]
  )

  const disconnect = useCallback(() => {
    setAddress(null)
    setChainId(null)
    setActiveProvider(null)
    clearWalletPreference()
    setShowModal(false)
    onDisconnect?.()
  }, [onDisconnect])

  // Connected state
  if (address) {
    return (
      <button className="connect-btn connected" onClick={disconnect} title={address}>
        {ensName || truncateAddress(address)}
      </button>
    )
  }

  // No wallets detected
  if (wallets.length === 0) {
    return (
      <button className="connect-btn" disabled>
        No Wallet
      </button>
    )
  }

  // Single wallet — connect directly
  if (wallets.length === 1) {
    return (
      <button className="connect-btn" onClick={() => handleConnect(wallets[0])}>
        Connect Wallet
      </button>
    )
  }

  // Multiple wallets — show picker modal
  return (
    <>
      <button className="connect-btn" onClick={() => setShowModal(true)}>
        Connect Wallet
      </button>
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Connect Wallet</h3>
            {error && <p className="wallet-error">{error}</p>}
            <ul className="wallet-list">
              {wallets.map((w) => (
                <li key={w.info.rdns}>
                  <button
                    className="wallet-option"
                    onClick={() => handleConnect(w)}
                  >
                    {w.info.icon && (
                      <img
                        src={w.info.icon}
                        alt=""
                        width="28"
                        height="28"
                      />
                    )}
                    {w.info.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}
