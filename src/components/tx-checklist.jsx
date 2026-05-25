import { truncateAddress } from '../lib/wallet'

// status: 'pending' | 'checking' | 'signing' | 'confirming' | 'done' | 'failed'
const STATUS_ICONS = {
  pending: '\u25cb',    // ○
  checking: '\u25cf',   // ●
  signing: '\u25cf',    // ●
  confirming: '\u25cf', // ●
  done: '\u2713',       // ✓
  failed: '\u2717',     // ✗
}

const STATUS_LABELS = {
  pending: 'Waiting',
  checking: 'Checking...',
  signing: 'Sign in wallet...',
  confirming: 'Confirming...',
  done: 'Done',
  failed: 'Failed',
}

export default function TxChecklist({ steps }) {
  if (!steps || steps.length === 0) return null

  return (
    <div className="tx-checklist">
      {steps.map((step, i) => (
        <div key={i} className={`tx-step tx-step-${step.status}`}>
          <span className="tx-step-icon">{STATUS_ICONS[step.status]}</span>
          <span className="tx-step-label">{step.label}</span>
          <span className="tx-step-status">{STATUS_LABELS[step.status]}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Build the list of steps for approvals + action(s).
 * One approval step per unique token contract, then one step per action label.
 */
export function buildSteps(assets, ...actionLabels) {
  const steps = []
  const seen = new Set()

  for (const asset of assets) {
    if (asset.assetType === 'NATIVE' || !asset.token) continue
    const key = asset.token.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      steps.push({
        label: `Approve ${truncateAddress(asset.token)}`,
        status: 'pending',
        type: 'approval',
        tokenAddress: asset.token,
      })
    }
  }

  for (const label of actionLabels) {
    if (!label) continue
    steps.push({ label, status: 'pending', type: 'action' })
  }

  return steps
}
