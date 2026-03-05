import { useState, useEffect, useCallback } from 'react'
import { useOutletContext, useNavigate } from 'react-router'
import AssetInput from '../components/asset-input'
import { ensureApproval, createOrder } from '../lib/contract'
import { encodeOrder } from '../lib/encoding'
import { CONTRACT_ADDRESSES } from '../lib/constants'
import { resolveENS } from '../lib/ens'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function emptyAsset() {
  return { token: '', tokenId: '', amount: '1', assetType: 0 }
}

export default function Create() {
  const wallet = useOutletContext()
  const navigate = useNavigate()

  const [makerAssets, setMakerAssets] = useState([emptyAsset()])
  const [takerAssets, setTakerAssets] = useState([emptyAsset()])
  const [taker, setTaker] = useState('')
  const [expiration, setExpiration] = useState('')
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [takerEns, setTakerEns] = useState(null)

  // Resolve ENS for taker address
  useEffect(() => {
    const addr = taker.trim()
    if (!addr || !addr.match(/^0x[0-9a-fA-F]{40}$/)) {
      setTakerEns(null)
      return
    }
    let cancelled = false
    resolveENS(addr).then((name) => {
      if (!cancelled) setTakerEns(name)
    })
    return () => { cancelled = true }
  }, [taker])

  const updateAsset = useCallback((list, setList, index, updated) => {
    const next = [...list]
    next[index] = updated
    setList(next)
  }, [])

  const removeAsset = useCallback((list, setList, index) => {
    if (list.length <= 1) return
    setList(list.filter((_, i) => i !== index))
  }, [])

  const addAsset = useCallback((list, setList) => {
    setList([...list, emptyAsset()])
  }, [])

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault()
    setError(null)

    if (!wallet) {
      setError('Connect your wallet first.')
      return
    }

    const chainId = wallet.chainId
    if (!CONTRACT_ADDRESSES[chainId]) {
      setError(`No contract deployed on this chain. Switch to a supported network.`)
      return
    }

    // Validate assets
    const allAssets = [...makerAssets, ...takerAssets]
    for (const asset of allAssets) {
      if (!asset.token || !asset.token.match(/^0x[0-9a-fA-F]{40}$/)) {
        setError('Invalid contract address: ' + (asset.token || '(empty)'))
        return
      }
      if (!asset.tokenId && asset.tokenId !== '0') {
        setError('Token ID is required for all assets.')
        return
      }
    }

    setSubmitting(true)

    try {
      // Request approvals for maker assets (deduplicate by token address)
      const uniqueTokens = [...new Set(makerAssets.map((a) => a.token.toLowerCase()))]
      for (const tokenAddr of uniqueTokens) {
        setStatus(`Approving ${tokenAddr.slice(0, 6)}...${tokenAddr.slice(-4)}...`)
        const tx = await ensureApproval(wallet.provider, chainId, tokenAddr, wallet.address)
        if (tx) await tx.wait()
      }

      // Build order params
      const salt = Date.now()
      const takerAddr = taker.trim() || ZERO_ADDRESS
      const exp = expiration ? Math.floor(new Date(expiration).getTime() / 1000) : 0

      const orderParams = {
        taker: takerAddr,
        makerAssets: makerAssets.map((a) => ({
          token: a.token,
          tokenId: a.tokenId,
          amount: a.assetType === 1 ? a.amount : '1',
          assetType: a.assetType,
        })),
        takerAssets: takerAssets.map((a) => ({
          token: a.token,
          tokenId: a.tokenId,
          amount: a.assetType === 1 ? a.amount : '1',
          assetType: a.assetType,
        })),
        expiration: exp,
        salt,
      }

      setStatus('Sending createOrder transaction...')
      const { orderHash } = await createOrder(wallet.provider, chainId, orderParams)

      // Build shareable URL
      const encoded = encodeOrder({
        maker: wallet.address,
        ...orderParams,
      })
      const contractAddress = CONTRACT_ADDRESSES[chainId]
      const swapPath = `/swap/${chainId}/${contractAddress}/${encoded}`

      setStatus(null)
      navigate(swapPath)
    } catch (err) {
      console.error(err)
      setError(err.reason || err.message || 'Transaction failed')
      setStatus(null)
    } finally {
      setSubmitting(false)
    }
  }, [wallet, makerAssets, takerAssets, taker, expiration, navigate])

  if (!wallet) {
    return (
      <div className="page create">
        <h1>Create Swap</h1>
        <p className="text-muted">Connect your wallet to create a swap.</p>
      </div>
    )
  }

  return (
    <div className="page create">
      <h1>Create Swap</h1>
      <form onSubmit={handleSubmit}>
        <div className="create-columns">
          <div className="create-column">
            <h2>You Send</h2>
            {makerAssets.map((asset, i) => (
              <AssetInput
                key={i}
                asset={asset}
                onChange={(updated) => updateAsset(makerAssets, setMakerAssets, i, updated)}
                onRemove={() => removeAsset(makerAssets, setMakerAssets, i)}
                chainId={wallet.chainId}
              />
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => addAsset(makerAssets, setMakerAssets)}>
              + Add Asset
            </button>
          </div>

          <div className="create-column">
            <h2>You Receive</h2>
            {takerAssets.map((asset, i) => (
              <AssetInput
                key={i}
                asset={asset}
                onChange={(updated) => updateAsset(takerAssets, setTakerAssets, i, updated)}
                onRemove={() => removeAsset(takerAssets, setTakerAssets, i)}
                chainId={wallet.chainId}
              />
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => addAsset(takerAssets, setTakerAssets)}>
              + Add Asset
            </button>
          </div>
        </div>

        <div className="create-options">
          <div className="form-field">
            <label htmlFor="taker">Taker Address (optional)</label>
            <input
              id="taker"
              type="text"
              placeholder="0x... (leave empty for open swap)"
              value={taker}
              onChange={(e) => setTaker(e.target.value)}
              spellCheck={false}
            />
            {takerEns && <span className="ens-hint">{takerEns}</span>}
          </div>
          <div className="form-field">
            <label htmlFor="expiration">Expiration (optional)</label>
            <input
              id="expiration"
              type="datetime-local"
              value={expiration}
              onChange={(e) => setExpiration(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}
        {status && <p className="form-status">{status}</p>}

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Swap'}
        </button>
      </form>
    </div>
  )
}
