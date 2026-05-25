import { createContext, createElement, useContext, useEffect, useState } from 'react'

// Wallet context — populated once AppKit loads asynchronously
const WalletContext = createContext(null)

export function useWallet() {
  return useContext(WalletContext)
}

// Loads appkit config first (createAppKit), then the React hooks module
const appkitReady = Promise.all([
  import('./appkit'),
  import('@reown/appkit/react'),
]).then(([config, react]) => ({ config, react }))

// Provider that async-loads AppKit and provides wallet state
export function WalletProvider({ children }) {
  const [appkit, setAppkit] = useState(null)
  const [wallet, setWallet] = useState(null)

  useEffect(() => {
    appkitReady.then(setAppkit)
  }, [])

  return createElement(WalletContext.Provider, { value: wallet },
    appkit ? createElement(WalletSync, { appkit: appkit.react, appkitConfig: appkit.config, setWallet }) : null,
    children
  )
}

// Invisible component that syncs AppKit hook state into the context
function WalletSync({ appkit, appkitConfig, setWallet }) {
  const { address, isConnected } = appkit.useAppKitAccount()
  const { walletProvider } = appkit.useAppKitProvider('eip155')
  const { chainId } = appkit.useAppKitNetwork()

  useEffect(() => {
    setWallet(isConnected ? { address, provider: walletProvider, chainId: Number(chainId) } : null)
  }, [address, isConnected, walletProvider, chainId, setWallet])

  useEffect(() => {
    function handleImageLoadError(event) {
      const path = event.composedPath?.() || []
      const isProfileAvatar = path.some((el) => el?.tagName?.toLowerCase?.() === 'wui-avatar')
      if (isProfileAvatar) appkitConfig.clearAppKitProfileImage()
    }

    window.addEventListener('onLoadError', handleImageLoadError)
    return () => window.removeEventListener('onLoadError', handleImageLoadError)
  }, [appkitConfig])

  return null
}
