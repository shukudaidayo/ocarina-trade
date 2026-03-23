import { useRef } from 'react'
import { useCreateFlow } from './context'
import AssetPicker from './asset-picker'
import AssetTally from './asset-tally'

export default function StepOffer({ wallet }) {
  const { next, back, chainId, makerAssets, setMakerAssets } = useCreateFlow()
  const pickerBackRef = useRef(null)

  const handleBack = () => {
    if (pickerBackRef.current && pickerBackRef.current()) return
    back()
  }

  return (
    <div className="wizard-screen">
      <h2>What are you offering?</h2>

      <AssetPicker
        address={wallet.address}
        chainId={chainId}
        selected={makerAssets}
        onChange={setMakerAssets}
        showNative={false}
        isOwnWallet={true}
        backRef={pickerBackRef}
      />

      <div className="wizard-footer">
        <AssetTally assets={makerAssets} chainId={chainId} />
        <div className="wizard-nav">
          <button type="button" className="btn btn-secondary" onClick={handleBack}>Back</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={next}
            disabled={makerAssets.length === 0}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}
