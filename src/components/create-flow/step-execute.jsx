import { useState, useEffect, useRef } from 'react'
import { useCreateFlow } from './context'
import { ensureApproval, createOrder, getOrderFromTx } from '../../lib/contract'
import { checkHoldings, checkKnownSeaportBlockedCollections, checkSeaportApprovals, checkSeaportTransferability } from '../../lib/asset-checks'
import { WHITELISTED_ERC20, CHAINS } from '../../lib/constants'
import { getExplorerTxUrl } from '../../lib/verification'
import { BrowserProvider, parseUnits } from 'ethers'
import { ItemType } from '@opensea/seaport-js/lib/constants'
import TxChecklist, { buildSteps } from '../tx-checklist'
import AssetTally from './asset-tally'
import { friendlyContractError } from '../../lib/errors'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const STUCK_SIGNATURE_DELAY_MS = 30000
const RETRYABLE_PENDING_STEPS = new Set(['Sign Order', 'Sign Listing', 'Register Order'])

function normalizeAsset(asset, chainId) {
  const itemType = asset.itemType !== undefined
    ? Number(asset.itemType)
    : asset.assetType === 'ERC20'
      ? ItemType.ERC20
      : asset.assetType === 'ERC1155'
        ? ItemType.ERC1155
        : ItemType.ERC721

  const normalized = {
    ...asset,
    itemType,
    identifierOrCriteria: asset.criteria ? '0' : asset.tokenId,
  }

  if (itemType === ItemType.ERC20) {
    const decimals = (WHITELISTED_ERC20[chainId]?.[asset.token])?.decimals ?? 18
    normalized.amount = parseUnits(asset.amount || '0', decimals).toString()
  }

  return normalized
}

function assertAll(results, message) {
  const failed = results.find((result) => (
    result.held === false ||
    result.approved === false ||
    result.transferable === false ||
    result.allowed === false
  ))
  if (failed) throw new Error(failed.reason ? `${message}: ${failed.reason}.` : message)
}

function friendlyError(err) {
  const msg = (err?.info?.error?.message || err?.reason || err?.shortMessage || err?.message || '').toLowerCase()
  if (msg.includes('rejected') || msg.includes('denied') || msg.includes('user refused') || msg.includes('user canceled')) {
    return 'Transaction rejected in wallet.'
  }
  if (msg.includes('insufficient funds') || msg.includes('insufficient balance')) {
    return 'Insufficient funds for gas.'
  }
  const contractMsg = friendlyContractError(err)
  if (contractMsg) return contractMsg

  return err?.reason || err?.shortMessage || err?.message || 'Transaction failed.'
}

function stuckStepMessage(label) {
  if (label.startsWith('Approve ')) {
    return `Still waiting on ${label}. If your wallet prompt is stuck and you have not submitted the transaction, reject or close any pending wallet request, then retry the checklist.`
  }
  if (label === 'Register Order') {
    return 'Still waiting on Register Order. If your wallet prompt is stuck and you have not submitted the transaction, reject or close any pending wallet request, then retry the checklist.'
  }

  return `Still waiting on ${label}. If your wallet prompt is stuck, reject or close any pending wallet request, then retry the checklist.`
}

export default function StepExecute({ wallet, onComplete }) {
  const { back, chainId, taker, makerAssets, takerAssets, expiration, memo } = useCreateFlow()
  const [steps, setSteps] = useState([])
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)
  const [submittedTx, setSubmittedTx] = useState(null)
  const [registrationCheck, setRegistrationCheck] = useState(null)
  const [checkingRegistration, setCheckingRegistration] = useState(false)
  const [stuckStep, setStuckStep] = useState(null)
  const startedRef = useRef(false)
  const completedRef = useRef(false)
  const runIdRef = useRef(0)
  const stuckTimerRef = useRef(null)
  const submittedTxHashRef = useRef(null)

  const wrongChain = wallet && wallet.chainId !== chainId
  const submittedTxHash = submittedTx?.hash || null
  const submittedTxUrl = submittedTxHash ? getExplorerTxUrl(chainId, submittedTxHash) : null

  useEffect(() => {
    if (startedRef.current || wrongChain) return
    startedRef.current = true
    execute()
  }, [wrongChain])

  useEffect(() => () => clearStuckTimer(), [])

  function clearStuckTimer() {
    if (stuckTimerRef.current) {
      clearTimeout(stuckTimerRef.current)
      stuckTimerRef.current = null
    }
  }

  function rememberSubmittedTx(tx) {
    submittedTxHashRef.current = tx?.hash || null
    setSubmittedTx(tx)
  }

  function scheduleStuckPrompt(step, runId) {
    clearStuckTimer()
    setStuckStep(null)

    if (step.status !== 'signing' || (!RETRYABLE_PENDING_STEPS.has(step.label) && step.type !== 'approval')) return

    stuckTimerRef.current = setTimeout(() => {
      if (runIdRef.current === runId && !completedRef.current && !submittedTxHashRef.current) {
        setStuckStep({ label: step.label })
      }
    }, STUCK_SIGNATURE_DELAY_MS)
  }

  function complete(txHash) {
    if (completedRef.current) return
    clearStuckTimer()
    setStuckStep(null)
    completedRef.current = true
    onComplete(chainId, txHash)
  }

  async function checkSubmittedTransaction() {
    if (!submittedTx || checkingRegistration) return

    setCheckingRegistration(true)
    setRegistrationCheck(null)

    try {
      if (submittedTx.kind === 'registration') {
        await getOrderFromTx(chainId, submittedTx.hash)
        complete(submittedTx.hash)
        return
      }

      const provider = new BrowserProvider(wallet.provider)
      const receipt = await provider.getTransactionReceipt(submittedTx.hash)
      if (!receipt) {
        setRegistrationCheck(`${submittedTx.label} transaction is not confirmed yet.`)
        return
      }
      if (receipt.status === 0) {
        setRegistrationCheck(`${submittedTx.label} transaction reverted.`)
        return
      }

      setRegistrationCheck(`${submittedTx.label} confirmed. Restarting the checklist...`)
      rememberSubmittedTx(null)
      execute()
    } catch (err) {
      const msg = friendlyError(err)
      setRegistrationCheck(`${submittedTx.label} is not confirmed yet. ${msg}`)
    } finally {
      setCheckingRegistration(false)
    }
  }

  function retryPendingStep() {
    clearStuckTimer()
    setStuckStep(null)
    execute()
  }

  async function execute() {
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    startedRef.current = true
    completedRef.current = false
    clearStuckTimer()
    setError(null)
    rememberSubmittedTx(null)
    setRegistrationCheck(null)
    setStuckStep(null)
    setRunning(true)

    const txSteps = [
      { label: 'Check Offered Assets', status: 'pending', type: 'action' },
      ...buildSteps(makerAssets, 'Verify Seaport Transfer', 'Sign Order', 'Sign Listing', 'Register Order'),
    ]
    setSteps([...txSteps])

    function updateStep(index, update) {
      if (runIdRef.current !== runId || completedRef.current) return
      txSteps[index] = { ...txSteps[index], ...update }
      setSteps([...txSteps])
      scheduleStuckPrompt(txSteps[index], runId)
    }

    function assertActive() {
      if (runIdRef.current !== runId || completedRef.current) {
        throw new Error('Checklist run was superseded.')
      }
    }

    let registerTxHash = null
    let pendingTx = null

    try {
      const normalizedMakerAssets = makerAssets.map((asset) => normalizeAsset(asset, chainId))
      const normalizedTakerAssets = takerAssets.map((asset) => normalizeAsset(asset, chainId))
      const criteriaIndexes = new Set(
        normalizedMakerAssets
          .map((asset, index) => asset.criteria ? index : -1)
          .filter((index) => index !== -1)
      )
      const exactMakerAssets = normalizedMakerAssets.filter((_, index) => !criteriaIndexes.has(index))

      const checkIndex = txSteps.findIndex((s) => s.label === 'Check Offered Assets')
      updateStep(checkIndex, { status: 'checking' })
      const blockedCollections = checkKnownSeaportBlockedCollections(chainId, [...normalizedMakerAssets, ...normalizedTakerAssets])
      const preHoldings = await checkHoldings(chainId, wallet.address, exactMakerAssets)
      assertActive()
      assertAll(preHoldings, 'You no longer hold all offered assets')
      assertAll(blockedCollections, 'A selected collection is not supported')
      updateStep(checkIndex, { status: 'done' })

      // Approvals
      const approvalSteps = txSteps.filter((s) => s.type === 'approval')
      for (let i = 0; i < approvalSteps.length; i++) {
        const step = approvalSteps[i]
        const stepIndex = txSteps.indexOf(step)
        updateStep(stepIndex, { status: 'signing' })

        const matchingAssets = makerAssets.filter((a) =>
          a.token && a.token.toLowerCase() === step.tokenAddress.toLowerCase()
        )
        const asset = matchingAssets[0]
        const itemType = asset?.assetType === 'ERC20' ? 1 : asset?.assetType === 'ERC1155' ? 3 : 2

        let approvalAmount
        if (itemType === 1) {
          const decimals = (WHITELISTED_ERC20[chainId]?.[asset.token])?.decimals ?? 18
          approvalAmount = matchingAssets
            .reduce((sum, a) => sum + parseUnits(a.amount || '0', decimals), 0n)
            .toString()
        }

        const tx = await ensureApproval(wallet.provider, step.tokenAddress, wallet.address, itemType, approvalAmount)
        assertActive()
        if (tx) {
          pendingTx = { kind: 'approval', label: step.label, hash: tx.hash }
          rememberSubmittedTx(pendingTx)
          updateStep(stepIndex, { status: 'confirming' })
          await tx.wait()
          assertActive()
          pendingTx = null
          rememberSubmittedTx(null)
        }
        updateStep(stepIndex, { status: 'done' })
      }

      const transferIndex = txSteps.findIndex((s) => s.label === 'Verify Seaport Transfer')
      updateStep(transferIndex, { status: 'checking' })
      const [postHoldings, approvals, transferability] = await Promise.all([
        checkHoldings(chainId, wallet.address, exactMakerAssets),
        checkSeaportApprovals(chainId, wallet.address, normalizedMakerAssets),
        checkSeaportTransferability(chainId, wallet.address, exactMakerAssets, taker || null),
      ])
      assertActive()
      assertAll(postHoldings, 'You no longer hold all offered assets')
      assertAll(approvals, 'Seaport approval is still missing for an offered asset')
      assertAll(transferability, 'Seaport cannot transfer an offered NFT')
      updateStep(transferIndex, { status: 'done' })

      // Sign Seaport order, then sign OTCRegistry listing, then register onchain
      const signOrderIndex = txSteps.findIndex((s) => s.label === 'Sign Order')
      const signListingIndex = txSteps.findIndex((s) => s.label === 'Sign Listing')
      const registerIndex = txSteps.findIndex((s) => s.label === 'Register Order')

      updateStep(signOrderIndex, { status: 'signing' })

      const expirationValue = expiration
        || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60

      const orderParams = {
        taker: taker || ZERO_ADDRESS,
        makerAssets,
        takerAssets,
        expiration: new Date(expirationValue * 1000).toISOString().slice(0, 16),
        makerAddress: wallet.address,
        memo: memo.trim(),
        onSeaportSigned: () => {
          assertActive()
          updateStep(signOrderIndex, { status: 'done' })
          updateStep(signListingIndex, { status: 'signing' })
        },
        onRegistrationSigned: () => {
          assertActive()
          updateStep(signListingIndex, { status: 'done' })
          updateStep(registerIndex, { status: 'signing' })
        },
      }

      const { tx, wait } = await createOrder(wallet.provider, chainId, orderParams)
      assertActive()
      registerTxHash = tx.hash
      pendingTx = { kind: 'registration', label: 'Registration', hash: tx.hash }
      rememberSubmittedTx(pendingTx)
      updateStep(registerIndex, { status: 'confirming' })
      await wait()
      assertActive()
      updateStep(registerIndex, { status: 'done' })

      complete(tx.hash)
    } catch (err) {
      if (runIdRef.current !== runId || completedRef.current) return
      console.error(err)
      clearStuckTimer()
      setStuckStep(null)
      if (pendingTx) rememberSubmittedTx(pendingTx)
      else if (registerTxHash) rememberSubmittedTx({ kind: 'registration', label: 'Registration', hash: registerTxHash })
      const failedIndex = txSteps.findIndex((s) => s.status === 'checking' || s.status === 'signing' || s.status === 'confirming')
      const msg = friendlyError(err)
      if (failedIndex !== -1) {
        updateStep(failedIndex, { status: 'failed', error: msg })
      }
      setError(msg)
      setRunning(false)
    }
  }

  return (
    <div className="wizard-screen">
      <h2>Submitting your offer</h2>

      <div className="execute-summary">
        <span>Offering: </span>
        <AssetTally assets={makerAssets} chainId={chainId} />
        <span> for </span>
        <AssetTally assets={takerAssets} chainId={chainId} />
      </div>

      <TxChecklist steps={steps} />

      {stuckStep && !submittedTxHash && !error && (
        <div className="execute-stuck">
          <p className="form-status">
            {stuckStepMessage(stuckStep.label)}
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retryPendingStep}>
            Retry checklist
          </button>
        </div>
      )}

      {submittedTxHash && (
        <div className="submitted-registration">
          <p className="form-status">
            {running
              ? `${submittedTx.label} transaction submitted. Waiting for confirmation...`
              : `${submittedTx.label} transaction was submitted. Check whether it confirmed before retrying this offer.`}
          </p>
          <div className="submitted-registration-actions">
            <a href={submittedTxUrl} target="_blank" rel="noreferrer">
              View transaction
            </a>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={checkSubmittedTransaction}
              disabled={checkingRegistration}
            >
              {checkingRegistration ? 'Checking...' : submittedTx.kind === 'registration' ? 'Check registration' : 'Check transaction'}
            </button>
          </div>
          {registrationCheck && <p className="form-error">{registrationCheck}</p>}
        </div>
      )}

      {wrongChain && !running && (
        <p className="form-error">
          Your wallet is on the wrong network. Please switch to {CHAINS[chainId]?.name || `chain ${chainId}`} to continue.
        </p>
      )}

      {error && (
        <div className="execute-error">
          <p className="form-error">{error}</p>
          <div className="wizard-nav">
            <button type="button" className="btn btn-secondary" onClick={back}>Back to Review</button>
            {!submittedTxHash && (
              <button type="button" className="btn" onClick={execute}>
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
