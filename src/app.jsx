import { Link, Outlet, useLocation } from 'react-router'
import { useAppKitAccount, useAppKitProvider, useAppKitNetwork } from '@reown/appkit/react'

export default function App() {
  const { address, isConnected } = useAppKitAccount()
  const { walletProvider } = useAppKitProvider('eip155')
  const { chainId } = useAppKitNetwork()
  const location = useLocation()

  const wallet = isConnected ? { address, provider: walletProvider, chainId: Number(chainId) } : null
  const isHome = location.pathname === '/'

  return (
    <div className="app">
      <header>
        <nav>
          <Link to="/" className="logo">ocarina.trade</Link>
          <div className="nav-links">
            <Link to="/create">Create</Link>
            <Link to="/offers">Offers</Link>
          </div>
          {!isHome && <appkit-button size="sm" balance="hide" />}
        </nav>
      </header>
      <main>
        <Outlet context={wallet} />
      </main>
      <footer>
        <p>DM <a href="https://x.com/shukudaidayo" target="_blank" rel="noopener noreferrer">@shukudaidayo</a> on Twitter with feedback</p>
      </footer>
    </div>
  )
}
