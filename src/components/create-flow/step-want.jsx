import { useState, useRef } from 'react'
import { useCreateFlow } from './context'
import AssetPicker from './asset-picker'
import AssetTally from './asset-tally'
import { resolveENSName } from '../../lib/ens'

export default function StepWant({ wallet }) {
  const { next, back, chainId, taker, setTaker, takerENS, setTakerENS, takerAssets, setTakerAssets } = useCreateFlow()
  const pickerBackRef = useRef(null)
  const [editingTaker, setEditingTaker] = useState(false)
  const [takerInput, setTakerInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState(null)

  const handleChangeTaker = async () => {
    const trimmed = takerInput.trim()
    if (!trimmed) return

    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      setTaker(trimmed)
      setTakerENS(null)
      setTakerAssets([])
      setEditingTaker(false)
      setTakerInput('')
      return
    }

    if (trimmed.includes('.')) {
      setResolving(true)
      setError(null)
      try {
        const addr = await resolveENSName(trimmed)
        if (addr) {
          setTaker(addr)
          setTakerENS(trimmed)
          setTakerAssets([])
          setEditingTaker(false)
          setTakerInput('')
        } else {
          setError('Could not resolve name.')
        }
      } catch {
        setError('Could not resolve name.')
      } finally {
        setResolving(false)
      }
      return
    }

    setError('Enter a valid address or ENS name.')
  }

  return (
    <div className="wizard-screen">
      <h2>What do you want in return?</h2>
      <div className="taker-subtitle">
        {editingTaker ? (
          <div className="inline-taker-edit">
            <span className="taker-label">From</span>
            <input
              type="text"
              placeholder="Address or ENS name"
              value={takerInput}
              onChange={(e) => { setTakerInput(e.target.value); setError(null) }}
              spellCheck={false}
              disabled={resolving}
            />
            <button type="button" className="btn btn-sm" onClick={handleChangeTaker} disabled={resolving}>
              {resolving ? '...' : 'Save'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingTaker(false)}>
              Cancel
            </button>
            {error && <p className="form-error">{error}</p>}
          </div>
        ) : (
          <div className="taker-display">
            <span>From {taker ? (takerENS || truncAddr(taker)) : 'Anyone'}</span>
            {taker && (
              <button
                type="button"
                className="btn-icon btn-sm"
                title="Remove taker"
                onClick={() => { setTaker(null); setTakerENS(null); setTakerAssets([]) }}
              >
                &times;
              </button>
            )}
            <button type="button" className="btn-link btn-sm" onClick={() => setEditingTaker(true)}>
              Change
            </button>
          </div>
        )}
      </div>

      <AssetPicker
        address={taker}
        chainId={chainId}
        selected={takerAssets}
        onChange={setTakerAssets}
        showNative={true}
        isOwnWallet={!!taker}
        dimZeroBalance={false}
        backRef={pickerBackRef}
      />

      <div className="wizard-footer">
        <AssetTally assets={takerAssets} chainId={chainId} />
        <div className="wizard-nav">
          <button type="button" className="btn btn-secondary" onClick={() => {
            if (pickerBackRef.current && pickerBackRef.current()) return
            back()
          }}>Back</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={next}
            disabled={takerAssets.length === 0}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}

function truncAddr(addr) {
  if (!addr) return '?'
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}
