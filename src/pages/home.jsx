import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router'
import { resolveENSName } from '../lib/ens'

export default function Home() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [error, setError] = useState(null)
  const [resolving, setResolving] = useState(false)

  useEffect(() => { setError(null) }, [input])

  const trimmed = input.trim()
  const isValidAddress = /^0x[0-9a-fA-F]{40}$/.test(trimmed)
  const isValidENS = trimmed.includes('.') && trimmed.length >= 3
  const isValid = isValidAddress || isValidENS

  const handleSubmit = async (e) => {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed) return

    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      navigate('/create', { state: { taker: trimmed } })
      return
    }

    if (trimmed.includes('.')) {
      setResolving(true)
      setError(null)
      try {
        const addr = await resolveENSName(trimmed)
        if (addr) {
          navigate('/create', { state: { taker: addr, takerENS: trimmed } })
        } else {
          setError('Could not resolve ENS name.')
        }
      } catch {
        setError('Could not resolve ENS name.')
      } finally {
        setResolving(false)
      }
      return
    }

    setError('Enter a valid Ethereum address or ENS name.')
  }

  return (
    <div className="page home">
      <form className="home-taker-form" onSubmit={handleSubmit}>
        <label htmlFor="taker-input">Who are you trading with?</label>
        <div className="home-taker-row">
          <input
            id="taker-input"
            type="text"
            placeholder="Wallet address or ENS name"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            disabled={resolving}
          />
          <button type="submit" className={`btn${isValid ? ' btn-primary' : ''}`} disabled={!trimmed || resolving}>
            {resolving ? 'Resolving...' : 'Start'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>

      <p className="home-open-offer">
        <button
          type="button"
          className="btn-link"
          onClick={() => navigate('/create', { state: { taker: null } })}
        >
          Or make an open offer anyone can accept
        </button>
      </p>

      <div className="home-actions">
        <Link to="/offers" className="btn btn-secondary">Browse Offers</Link>
      </div>

    </div>
  )
}
