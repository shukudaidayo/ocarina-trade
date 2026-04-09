import { useState, useEffect } from 'react'
import { useOutletContext, useLocation } from 'react-router'
import { CreateFlowProvider, useCreateFlow, STEPS } from '../components/create-flow/context'
import WizardShell from '../components/create-flow/wizard-shell'
import StepConnect from '../components/create-flow/step-connect'
import StepChain from '../components/create-flow/step-chain'
import StepOffer from '../components/create-flow/step-offer'
import StepWant from '../components/create-flow/step-want'
import StepReview from '../components/create-flow/step-review'
import StepExecute from '../components/create-flow/step-execute'
import StepDone from '../components/create-flow/step-done'

export default function Create() {
  useEffect(() => { document.title = 'Create Offer — ocarina.trade' }, [])
  const wallet = useOutletContext()
  const location = useLocation()
  const { taker, takerENS } = location.state || {}

  return (
    <CreateFlowProvider initialTaker={taker} initialTakerENS={takerENS}>
      <CreateWizardWrapper wallet={wallet} />
    </CreateFlowProvider>
  )
}

function CreateWizardWrapper({ wallet }) {
  const [completed, setCompleted] = useState(false)

  return (
    <WizardShell allComplete={completed}>
      <CreateWizard wallet={wallet} onCompleted={() => setCompleted(true)} />
    </WizardShell>
  )
}

function CreateWizard({ wallet, onCompleted }) {
  const { step, goTo } = useCreateFlow()
  const [completedChainId, setCompletedChainId] = useState(null)
  const [completedTxHash, setCompletedTxHash] = useState(null)

  // If wallet disconnects mid-flow, go back to Connect step
  useEffect(() => {
    if (!wallet && step > 0 && !completedTxHash) goTo(0)
  }, [wallet, step, completedTxHash, goTo])

  const handleComplete = (chainId, txHash) => {
    setCompletedChainId(chainId)
    setCompletedTxHash(txHash)
    onCompleted()
  }

  // Done screen (after all steps)
  if (completedTxHash) {
    return <StepDone chainId={completedChainId} txHash={completedTxHash} />
  }

  const stepKey = STEPS[step]?.key

  // While useEffect redirects to Connect, guard against render with null wallet
  if (!wallet && stepKey !== 'connect') return null

  switch (stepKey) {
    case 'connect':
      return <StepConnect wallet={wallet} />
    case 'chain':
      return <StepChain wallet={wallet} />
    case 'offer':
      return <StepOffer wallet={wallet} />
    case 'want':
      return <StepWant wallet={wallet} />
    case 'review':
      return <StepReview wallet={wallet} />
    case 'execute':
      return <StepExecute wallet={wallet} onComplete={handleComplete} />
    default:
      return null
  }
}
