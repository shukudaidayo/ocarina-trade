import { useState, useEffect, useRef } from 'react'
import { useCreateFlow } from './context'
import { ensureApproval, createOrder } from '../../lib/contract'
import { checkHoldings, checkSeaportApprovals } from '../../lib/asset-checks'
import { ZONE_ADDRESSES, WHITELISTED_ERC20, CHAINS } from '../../lib/constants'
import { parseUnits } from 'ethers'
import { ItemType } from '@opensea/seaport-js/lib/constants'
import TxChecklist, { buildSteps } from '../tx-checklist'
import AssetTally from './asset-tally'
import { friendlyContractError } from '../../lib/errors'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function normalizeMakerAsset(asset, chainId) {
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
  const failed = results.find((result) => !result.held && !result.approved)
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

export default function StepExecute({ wallet, onComplete }) {
  const { back, chainId, taker, makerAssets, takerAssets, expiration, memo } = useCreateFlow()
  const [steps, setSteps] = useState([])
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)
  const startedRef = useRef(false)

  const wrongChain = wallet && wallet.chainId !== chainId

  useEffect(() => {
    if (startedRef.current || wrongChain) return
    startedRef.current = true
    execute()
  }, [wrongChain])

  async function execute() {
    setError(null)
    setRunning(true)

    const txSteps = buildSteps(makerAssets, 'Check Offered Assets', 'Sign Order', 'Sign Listing', 'Register Order')
    setSteps([...txSteps])

    function updateStep(index, update) {
      txSteps[index] = { ...txSteps[index], ...update }
      setSteps([...txSteps])
    }

    try {
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
        if (tx) {
          updateStep(stepIndex, { status: 'confirming' })
          await tx.wait()
        }
        updateStep(stepIndex, { status: 'done' })
      }

      const checkIndex = txSteps.findIndex((s) => s.label === 'Check Offered Assets')
      updateStep(checkIndex, { status: 'checking' })
      const normalizedMakerAssets = makerAssets.map((asset) => normalizeMakerAsset(asset, chainId))
      const criteriaIndexes = new Set(
        normalizedMakerAssets
          .map((asset, index) => asset.criteria ? index : -1)
          .filter((index) => index !== -1)
      )
      const [holdings, approvals] = await Promise.all([
        checkHoldings(chainId, wallet.address, normalizedMakerAssets.filter((_, index) => !criteriaIndexes.has(index))),
        checkSeaportApprovals(chainId, wallet.address, normalizedMakerAssets),
      ])
      assertAll(holdings, 'You no longer hold all offered assets')
      assertAll(approvals, 'Seaport approval is still missing for an offered asset')
      updateStep(checkIndex, { status: 'done' })

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
          updateStep(signOrderIndex, { status: 'done' })
          updateStep(signListingIndex, { status: 'signing' })
        },
        onRegistrationSigned: () => {
          updateStep(signListingIndex, { status: 'done' })
          updateStep(registerIndex, { status: 'signing' })
        },
      }

      const { tx, wait } = await createOrder(wallet.provider, chainId, orderParams)
      updateStep(registerIndex, { status: 'confirming' })
      await wait()
      updateStep(registerIndex, { status: 'done' })

      onComplete(chainId, tx.hash)
    } catch (err) {
      console.error(err)
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
            <button type="button" className="btn" onClick={() => { startedRef.current = false; execute() }}>
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
