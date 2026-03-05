import { useState, useCallback } from 'react'
import { Link, Outlet } from 'react-router'
import WalletButton from './components/wallet-button'

export default function App() {
  const [wallet, setWallet] = useState(null)

  const handleConnect = useCallback((address, provider, chainId) => {
    setWallet({ address, provider, chainId })
  }, [])

  const handleDisconnect = useCallback(() => {
    setWallet(null)
  }, [])

  return (
    <div className="app">
      <header>
        <nav>
          <Link to="/" className="logo">OTC Swap</Link>
          <div className="nav-links">
            <Link to="/create">Create</Link>
            <Link to="/offers">Offers</Link>
          </div>
          <WalletButton onConnect={handleConnect} onDisconnect={handleDisconnect} />
        </nav>
      </header>
      <main>
        <Outlet context={wallet} />
      </main>
      <footer>
        <p>OTC Swap — peer-to-peer NFT swaps, fully on-chain</p>
      </footer>
    </div>
  )
}
