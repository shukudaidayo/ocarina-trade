import { Suspense } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { useWallet, WalletProvider } from './lib/wallet-hooks'

function AppShell() {
  const wallet = useWallet()
  const location = useLocation()

  const isHome = location.pathname === '/'
  const isCreate = location.pathname === '/create'
  const isFaq = location.pathname === '/faq'

  return (
    <div className="app">
      <header>
        <nav>
          <Link to="/" className="logo">ocarina.trade</Link>
          <div className="nav-links">
            <Link to="/offers">Offers</Link>
            <Link to="/faq">FAQ</Link>
          </div>
          {!isHome && !isFaq && (wallet || !isCreate) && <appkit-button size="sm" balance="hide" />}
        </nav>
      </header>
      <main>
        <Suspense fallback={<div className="page"><p className="text-muted">Loading...</p></div>}>
          <Outlet context={wallet} />
        </Suspense>
      </main>
      <footer>
        <p>DM <a href="https://x.com/shukudaidayo" target="_blank" rel="noopener noreferrer">@shukudaidayo</a> on Twitter with feedback</p>
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <WalletProvider>
      <AppShell />
    </WalletProvider>
  )
}
