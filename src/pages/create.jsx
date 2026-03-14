import { useState, useEffect, useCallback } from 'react'
import { useOutletContext, useNavigate } from 'react-router'
import AssetInput from '../components/asset-input'
import NFTPicker from '../components/nft-picker'
import { ensureApproval, createOrder } from '../lib/contract'
import { ZONE_ADDRESSES, WHITELISTED_ERC20 } from '../lib/constants'
import { parseUnits } from 'ethers'
import { resolveENS, resolveENSName } from '../lib/ens'
import TxChecklist, { buildSteps } from '../components/tx-checklist'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function emptyAsset() {
  return { token: '', tokenId: '', amount: '1', assetType: 'ERC721' }
}

export default function Create() {
  const wallet = useOutletContext()
  const navigate = useNavigate()

  const [makerAssets, setMakerAssets] = useState([emptyAsset()])
  const [takerAssets, setTakerAssets] = useState([emptyAsset()])
  const [taker, setTaker] = useState('')
  const [expiration, setExpiration] = useState('')
  const [steps, setSteps] = useState([])
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [takerEns, setTakerEns] = useState(null) // reverse: address → name
  const [takerResolved, setTakerResolved] = useState(null) // forward: name → address
  const [pickerSide, setPickerSide] = useState(null) // 'offer' | 'consideration' | null

  // Resolve ENS: address → name (reverse) or name → address (forward)
  useEffect(() => {
    const input = taker.trim()
    if (!input) {
      setTakerEns(null)
      setTakerResolved(null)
      return
    }

    let cancelled = false

    if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
      // Input is an address — reverse lookup
      setTakerResolved(null)
      resolveENS(input).then((name) => {
        if (!cancelled) setTakerEns(name)
      })
    } else if (input.includes('.')) {
      // Input looks like an ENS name — forward lookup
      setTakerEns(null)
      resolveENSName(input).then((addr) => {
        if (!cancelled) setTakerResolved(addr)
      })
    } else {
      setTakerEns(null)
      setTakerResolved(null)
    }

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

  const handlePickerSelect = useCallback((asset) => {
    const setList = pickerSide === 'offer' ? setMakerAssets : setTakerAssets
    setList((prev) => {
      // Replace first empty asset, or append
      const emptyIndex = prev.findIndex((a) => !a.token && !a.tokenId)
      if (emptyIndex !== -1) {
        const next = [...prev]
        next[emptyIndex] = asset
        return next
      }
      return [...prev, asset]
    })
    setPickerSide(null)
  }, [pickerSide])

  // The effective taker address: either typed directly or resolved from ENS
  const takerAddress = /^0x[0-9a-fA-F]{40}$/.test(taker.trim()) ? taker.trim() : takerResolved

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault()
    setError(null)

    if (!wallet) {
      setError('Connect your wallet first.')
      return
    }

    const chainId = wallet.chainId
    if (!ZONE_ADDRESSES[chainId]) {
      setError(`No OTCZone deployed on this chain. Switch to a supported network.`)
      return
    }

    // Validate assets
    const allAssets = [...makerAssets, ...takerAssets]
    for (const asset of allAssets) {
      if (asset.assetType === 'NATIVE') {
        if (!asset.amount || isNaN(Number(asset.amount)) || Number(asset.amount) <= 0) {
          setError('ETH amount must be a positive number.')
          return
        }
        continue
      }
      if (!asset.token || !asset.token.match(/^0x[0-9a-fA-F]{40}$/)) {
        setError('Invalid contract address: ' + (asset.token || '(empty)'))
        return
      }
      if (asset.assetType === 'ERC20') {
        if (!asset.amount || isNaN(Number(asset.amount)) || Number(asset.amount) <= 0) {
          setError('ERC-20 amount must be a positive number.')
          return
        }
        continue
      }
      if (!asset.tokenId && asset.tokenId !== '0') {
        setError('Token ID is required for NFT assets.')
        return
      }
    }

    setSubmitting(true)

    const txSteps = buildSteps(makerAssets, 'Sign Order', 'Register Order')
    setSteps(txSteps)

    function updateStep(index, update) {
      txSteps[index] = { ...txSteps[index], ...update }
      setSteps([...txSteps])
    }

    try {
      // Request approvals for maker assets to Seaport (skip native ETH)
      const approvalSteps = txSteps.filter((s) => s.type === 'approval')
      for (let i = 0; i < approvalSteps.length; i++) {
        const step = approvalSteps[i]
        const stepIndex = txSteps.indexOf(step)
        updateStep(stepIndex, { status: 'signing' })

        const matchingAssets = makerAssets.filter((a) => a.token && a.token.toLowerCase() === step.tokenAddress.toLowerCase())
        const asset = matchingAssets[0]
        const itemType = asset?.assetType === 'ERC20' ? 1 : asset?.assetType === 'ERC1155' ? 3 : 2
        // For ERC-20, compute exact approval amount in base units
        let approvalAmount
        if (itemType === 1) {
          const decimals = (WHITELISTED_ERC20[wallet.chainId]?.[asset.token])?.decimals ?? 18
          approvalAmount = matchingAssets.reduce((sum, a) => sum + parseUnits(a.amount || '0', decimals), 0n).toString()
        }
        const tx = await ensureApproval(wallet.provider, step.tokenAddress, wallet.address, itemType, approvalAmount)
        if (tx) {
          updateStep(stepIndex, { status: 'confirming' })
          await tx.wait()
        }
        updateStep(stepIndex, { status: 'done' })
      }

      // Sign the Seaport order (no gas)
      const signIndex = txSteps.length - 2
      updateStep(signIndex, { status: 'signing' })

      const takerAddr = takerAddress || ZERO_ADDRESS
      const orderParams = {
        taker: takerAddr,
        makerAssets,
        takerAssets,
        expiration,
        makerAddress: wallet.address,
      }

      // createOrder handles signing + registration
      const { tx, wait } = await createOrder(wallet.provider, wallet.chainId, orderParams)
      updateStep(signIndex, { status: 'done' })

      // Register on-chain
      const registerIndex = txSteps.length - 1
      updateStep(registerIndex, { status: 'confirming' })
      await wait()
      updateStep(registerIndex, { status: 'done' })

      const swapPath = `/swap/${wallet.chainId}/${tx.hash}`
      navigate(swapPath)
    } catch (err) {
      console.error(err)
      const failedIndex = txSteps.findIndex((s) => s.status === 'signing' || s.status === 'confirming')
      if (failedIndex !== -1) {
        updateStep(failedIndex, { status: 'failed', error: err.reason || err.message || 'Failed' })
      }
      setError(err.reason || err.message || 'Transaction failed')
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
                side="offer"
              />
            ))}
            <div className="create-column-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => addAsset(makerAssets, setMakerAssets)}>
                + Add Manually
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPickerSide('offer')}>
                Pick from Wallet
              </button>
            </div>
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
                side="consideration"
              />
            ))}
            <div className="create-column-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => addAsset(takerAssets, setTakerAssets)}>
                + Add Manually
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPickerSide('consideration')}
                disabled={!takerAddress}
                title={takerAddress ? 'Pick from taker wallet' : 'Enter a taker address first'}
              >
                Pick from Wallet
              </button>
            </div>
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
            {takerResolved && <span className="ens-hint">{takerResolved}</span>}
          </div>
          <div className="form-field">
            <label htmlFor="expiration">Expiration (defaults to 30 days)</label>
            <input
              id="expiration"
              type="datetime-local"
              value={expiration}
              onChange={(e) => setExpiration(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}
        <TxChecklist steps={steps} />

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Swap'}
        </button>
      </form>

      {pickerSide && (
        <NFTPicker
          address={pickerSide === 'offer' ? wallet.address : takerAddress}
          chainId={wallet.chainId}
          onSelect={handlePickerSelect}
          onClose={() => setPickerSide(null)}
        />
      )}
    </div>
  )
}
