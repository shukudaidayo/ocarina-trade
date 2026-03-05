import { Link } from 'react-router'

export default function Home() {
  return (
    <div className="page home">
      <h1>OTC Swap</h1>
      <p>Peer-to-peer NFT swaps. No middleman, no escrow, fully on-chain.</p>
      <div className="home-actions">
        <Link to="/create" className="btn">Create a Swap</Link>
        <Link to="/offers" className="btn btn-secondary">Browse Offers</Link>
      </div>
    </div>
  )
}
