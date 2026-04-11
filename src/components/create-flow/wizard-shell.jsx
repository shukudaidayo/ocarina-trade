import { useEffect } from 'react'
import { useBlocker } from 'react-router'
import { useCreateFlow, STEPS } from './context'

export default function WizardShell({ children, allComplete = false }) {
  const { step, goTo, hasMakerAssets } = useCreateFlow()

  // Warn on tab close / refresh if user has selected assets
  useEffect(() => {
    if (!hasMakerAssets || allComplete) return

    const handler = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasMakerAssets, allComplete])

  // Block in-app navigation (e.g. clicking "Browse Offers") if user has selected assets
  const blocker = useBlocker(hasMakerAssets && !allComplete)

  useEffect(() => {
    if (blocker.state === 'blocked') {
      const leave = window.confirm(
        "Are you sure you want to leave? Your offer hasn't been submitted and all changes will be lost."
      )
      if (leave) {
        blocker.proceed()
      } else {
        blocker.reset()
      }
    }
  }, [blocker])

  // Don't show step indicator on the done screen (after execute)
  const showSteps = step < STEPS.length

  return (
    <div className="wizard">
      {showSteps && (
        <div className="wizard-steps">
          {STEPS.map((s, i) => {
            const isComplete = allComplete || i < step
            const isCurrent = !allComplete && i === step
            const isFuture = !allComplete && i > step
            return (
              <button
                key={s.key}
                className={`wizard-step${isCurrent ? ' wizard-step-current' : ''}${isComplete ? ' wizard-step-complete' : ''}${isFuture ? ' wizard-step-future' : ''}`}
                onClick={() => isComplete && goTo(i)}
                disabled={isFuture}
                type="button"
              >
                <span className="wizard-step-dot" />
                <span className="wizard-step-label">{s.label}</span>
              </button>
            )
          })}
        </div>
      )}
      <div className="wizard-content">
        {children}
      </div>
    </div>
  )
}
