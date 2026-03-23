import { createContext, useContext, useState, useCallback } from 'react'

const CreateFlowContext = createContext(null)

export const STEPS = [
  { key: 'connect', label: 'Connect' },
  { key: 'chain', label: 'Chain' },
  { key: 'offer', label: 'You Offer' },
  { key: 'want', label: 'You Want' },
  { key: 'review', label: 'Review' },
  { key: 'execute', label: 'Submit' },
]

export function CreateFlowProvider({ children, initialTaker, initialTakerENS }) {
  const [step, setStep] = useState(0)
  const [taker, setTaker] = useState(initialTaker ?? null)
  const [takerENS, setTakerENS] = useState(initialTakerENS ?? null)
  const [chainId, setChainId] = useState(null)
  const [makerAssets, setMakerAssets] = useState([])
  const [takerAssets, setTakerAssets] = useState([])
  const [expiration, setExpiration] = useState(null)
  const [memo, setMemo] = useState('')

  const next = useCallback(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), [])
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 0)), [])
  const goTo = useCallback((i) => setStep(i), [])

  // Has the user done meaningful work that would be lost?
  const hasMakerAssets = makerAssets.length > 0

  return (
    <CreateFlowContext.Provider value={{
      step, setStep, next, back, goTo,
      taker, setTaker,
      takerENS, setTakerENS,
      chainId, setChainId,
      makerAssets, setMakerAssets,
      takerAssets, setTakerAssets,
      expiration, setExpiration,
      memo, setMemo,
      hasMakerAssets,
    }}>
      {children}
    </CreateFlowContext.Provider>
  )
}

export function useCreateFlow() {
  const ctx = useContext(CreateFlowContext)
  if (!ctx) throw new Error('useCreateFlow must be used within CreateFlowProvider')
  return ctx
}
