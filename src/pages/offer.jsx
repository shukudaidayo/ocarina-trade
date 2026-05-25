import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext } from 'react-router'
import { getOrderFromTx, getOrderStatus, getCounter, fulfillOrder, cancelOrder, ensureApproval, simulateFulfillment, deriveOrderStatus, getFillTxHash, signTipAuthorization } from '../lib/contract'
import { checkHoldings, checkSeaportApprovals } from '../lib/asset-checks'
import { getExplorerTxUrl, getVerificationStatus } from '../lib/verification'
import { fetchMetadata } from '../lib/metadata'
import { resolveENS } from '../lib/ens'
import { generateTradeImage, preloadAssetImages } from '../lib/share-image'
import AssetCard from '../components/asset-card'
import AddressDisplay from '../components/address-display'
import { truncateAddress } from '../lib/wallet'
import TxChecklist, { buildSteps } from '../components/tx-checklist'
import { WHITELISTED_ERC20, CHAINS, OCARINA_SUPPORT_ADDRESS, USDC_ADDRESSES } from '../lib/constants'
import { ItemType } from '@opensea/seaport-js/lib/constants'
import { Contract, formatUnits, JsonRpcProvider, parseUnits } from 'ethers'
import { formatTokenAmount } from '../lib/wallet'
import { friendlyContractError } from '../lib/errors'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const SUPPORT_TIP_DEFAULT_USDC_UNITS = 5_000_000n
const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)']

function friendlyFillError(err) {
  const contractMsg = friendlyContractError(err, { preferSeaport: true })
  if (contractMsg) return contractMsg

  const raw = err.data || err.message || ''
  // Seaport reverts with generic data when token transfers fail
  if (raw.includes('execution reverted') || err.code === 'CALL_EXCEPTION') {
    return 'This offer cannot be accepted. The maker may no longer hold the offered assets, or approvals may have been revoked.'
  }
  const nested = (err?.info?.error?.message || '').toLowerCase()
  if (err.code === 'ACTION_REJECTED' || raw.includes('user rejected') || nested.includes('rejected') || nested.includes('denied') || nested.includes('user refused') || nested.includes('user canceled')) {
    return 'Transaction rejected in wallet.'
  }
  if (nested.includes('insufficient funds') || raw.includes('insufficient funds')) {
    return 'Insufficient funds for gas.'
  }
  return err.reason || err.shortMessage || 'Transaction failed.'
}

function isCriteriaItem(item) {
  const itemType = Number(item.itemType)
  return itemType === ItemType.ERC721_WITH_CRITERIA || itemType === ItemType.ERC1155_WITH_CRITERIA
}

function exactItemType(item) {
  const itemType = Number(item.itemType)
  if (itemType === ItemType.ERC721_WITH_CRITERIA) return ItemType.ERC721
  if (itemType === ItemType.ERC1155_WITH_CRITERIA) return ItemType.ERC1155
  return itemType
}

function resolveCriteriaItems(items, selections = {}) {
  const missing = new Set()
  const resolved = items.map((item, index) => {
    if (!isCriteriaItem(item)) return item
    const selected = selections[index]
    if (!selected && selected !== '0') {
      missing.add(index)
      return { ...item, itemType: exactItemType(item) }
    }
    return {
      ...item,
      itemType: exactItemType(item),
      identifierOrCriteria: selected,
    }
  })
  return { items: resolved, missing }
}

function applyMissingCriteria(results, missing) {
  return results.map((result, index) => (
    missing.has(index) ? { held: false, reason: 'Choose token ID' } : result
  ))
}

function hasMissingCriteria(params, selections) {
  return params.offer.some((item, index) => isCriteriaItem(item) && !selections.offer?.[index] && selections.offer?.[index] !== '0')
    || params.consideration.some((item, index) => isCriteriaItem(item) && !selections.consideration?.[index] && selections.consideration?.[index] !== '0')
}

function hasDuplicateERC721CriteriaSelections(params, selections) {
  return ['offer', 'consideration'].some((side) => {
    const seen = new Set()
    return params[side].some((item, index) => {
      if (Number(item.itemType) !== ItemType.ERC721_WITH_CRITERIA) return false
      const selected = selections[side]?.[index]
      if (!selected && selected !== '0') return false
      const key = `${item.token.toLowerCase()}:${selected}`
      if (seen.has(key)) return true
      seen.add(key)
      return false
    })
  })
}

function whitelistedTokenInfo(chainId, token) {
  const normalized = token?.toLowerCase()
  if (!normalized) return null
  const match = Object.entries(WHITELISTED_ERC20[Number(chainId)] || {})
    .find(([address]) => address.toLowerCase() === normalized)
  return match?.[1] || null
}

function supportTipToken(chainId) {
  const token = USDC_ADDRESSES[Number(chainId)]
  if (!token) return null
  const info = whitelistedTokenInfo(chainId, token)
  return { address: token, decimals: info?.decimals ?? 6 }
}

function formatSupportTipUnits(amount, chainId) {
  const token = supportTipToken(chainId)
  const formatted = formatUnits(amount > 0n ? amount : 0n, token?.decimals ?? 6)
  return formatted.includes('.') ? formatted.replace(/\.?0+$/, '') || '0' : formatted
}

function parseSupportTipAmount(value, chainId) {
  const token = supportTipToken(chainId)
  if (!token) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return parseUnits(trimmed, token.decimals)
  } catch {
    return null
  }
}

function hasTooManySupportTipDecimals(value, chainId) {
  const token = supportTipToken(chainId)
  const trimmed = value.trim()
  const numericLike = /^\d*(?:\.\d*)?$/.test(trimmed)
  if (!numericLike || !trimmed.includes('.')) return false
  const [, fraction = ''] = trimmed.split('.')
  return fraction.length > (token?.decimals ?? 6)
}

function supportTipForChain(chainId, amount = SUPPORT_TIP_DEFAULT_USDC_UNITS) {
  const token = USDC_ADDRESSES[Number(chainId)]
  if (!token) return null
  const amountUnits = typeof amount === 'bigint' ? amount : BigInt(amount)
  if (amountUnits <= 0n) return null
  return {
    itemType: ItemType.ERC20,
    token,
    identifier: '0',
    amount: amountUnits.toString(),
    recipient: OCARINA_SUPPORT_ADDRESS,
  }
}

function supportTipAsset(chainId, amount) {
  const tip = supportTipForChain(chainId, amount)
  if (!tip) return null
  return {
    token: tip.token,
    tokenId: tip.identifier,
    amount: tip.amount,
    startAmount: tip.amount,
    assetType: 'ERC20',
    itemType: ItemType.ERC20,
  }
}

function requiredSupportTipTokenConsideration(items, chainId) {
  const token = USDC_ADDRESSES[Number(chainId)]?.toLowerCase()
  if (!token) return 0n
  return items.reduce((sum, item) => {
    if (Number(item.itemType) !== ItemType.ERC20) return sum
    if (item.token?.toLowerCase() !== token) return sum
    return sum + BigInt(item.startAmount)
  }, 0n)
}

export default function Offer() {
  useEffect(() => { document.title = 'Offer — ocarina.trade' }, [])
  const { chainId, txHash } = useParams()
  const wallet = useOutletContext()

  const [orderData, setOrderData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [statusLabel, setStatusLabel] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [steps, setSteps] = useState([])
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [offerHoldings, setOfferHoldings] = useState(null) // array parallel to offer items
  const [offerApprovals, setOfferApprovals] = useState(null) // array parallel to offer items
  const [considerationHoldings, setConsiderationHoldings] = useState(null) // array parallel to consideration items
  const [supportTipBalance, setSupportTipBalance] = useState(null)
  const [supportTipBalanceStatus, setSupportTipBalanceStatus] = useState('idle')
  const [supportTipRequiredUSDC, setSupportTipRequiredUSDC] = useState(0n)
  const [supportTipAmountInput, setSupportTipAmountInput] = useState('0')
  const [showVerifyModal, setShowVerifyModal] = useState(false)
  const [unverifiedAssets, setUnverifiedAssets] = useState([])
  const [fillTxHash, setFillTxHash] = useState(null)
  const [fulfiller, setFulfiller] = useState(null)
  const [shareImageBlob, setShareImageBlob] = useState(null)
  const [shareImageUrl, setShareImageUrl] = useState(null)
  const [generatingImage, setGeneratingImage] = useState(false)
  const [criteriaSelections, setCriteriaSelections] = useState({ offer: {}, consideration: {} })
  const [supportOcarina, setSupportOcarina] = useState(false)

  // Fetch order data from tx hash
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        setOrderData(null)
        setLoadError(null)
        setStatusLabel(null)
        setStatusLoading(true)
        setFillTxHash(null)
        setFulfiller(null)
        const data = await getOrderFromTx(Number(chainId), txHash)
        if (cancelled) return
        setOrderData(data)
      } catch (err) {
        console.error('Failed to load order:', err)
        if (!cancelled) {
          setLoadError(err.message || 'Failed to load order from transaction.')
          setStatusLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [chainId, txHash])

  // Fetch order status separately so a transient RPC failure doesn't destroy loaded order data
  useEffect(() => {
    if (!orderData) return
    if (orderData.archived) {
      setStatusLabel(orderData.status)
      setStatusLoading(false)
      if (orderData.resolution?.txHash) setFillTxHash(orderData.resolution.txHash)
      if (orderData.resolution?.fulfiller) setFulfiller(orderData.resolution.fulfiller)
      return
    }
    let cancelled = false
    async function load() {
      try {
        const [status, liveCounter] = await Promise.all([
          getOrderStatus(Number(chainId), orderData.orderHash),
          getCounter(Number(chainId), orderData.order.parameters.offerer).catch(() => undefined),
        ])
        if (!cancelled) {
          const { endTime, counter: orderCounter } = orderData.order.parameters
          setStatusLabel(deriveOrderStatus(status, endTime, liveCounter, orderCounter))
        }
      } catch (err) {
        console.error('Failed to load order status:', err)
        // Still show the order — just without status
      } finally {
        if (!cancelled) setStatusLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [orderData, chainId])

  // Fetch fill transaction hash + fulfiller address for filled orders
  useEffect(() => {
    if (!orderData || statusLabel !== 'filled') return
    if (orderData.archived) return
    let cancelled = false
    const offerer = orderData.order.parameters.offerer
    const cid = Number(chainId)
    getFillTxHash(cid, orderData.orderHash, offerer).then(async (hash) => {
      if (cancelled || !hash) return
      setFillTxHash(hash)
      // Resolve fulfiller from tx.from when taker is open (zero address)
      if (orderData.taker === ZERO_ADDRESS) {
        try {
          const chain = CHAINS[cid]
          if (chain) {
            const { JsonRpcProvider } = await import('ethers')
            const provider = new JsonRpcProvider(chain.rpcUrl)
            const tx = await provider.getTransaction(hash)
            if (!cancelled && tx?.from) setFulfiller(tx.from)
          }
        } catch {}
      }
    })
    return () => { cancelled = true }
  }, [orderData, statusLabel, chainId])

  // Generate share image when offer is filled
  useEffect(() => {
    if (!orderData || statusLabel !== 'filled') return
    // Wait for fulfiller to be resolved on open offers
    const isOpen = orderData.taker === ZERO_ADDRESS
    if (isOpen && !fulfiller) return
    const effectiveTaker = isOpen ? fulfiller : orderData.taker

    let cancelled = false
    setGeneratingImage(true)

    ;(async () => {
      const params = orderData.order.parameters
      const cid = Number(chainId)

      // Fetch metadata for all items
      const offerItems = await Promise.all(params.offer.map(async (o) => {
        const it = Number(o.itemType)
        let _name = null, _image = null
        if (it === ItemType.ERC721 || it === ItemType.ERC1155) {
          try {
            const meta = await fetchMetadata(cid, o.token, o.identifierOrCriteria, it === 3 ? 1 : 0)
            _name = meta?.name
            _image = meta?.image
          } catch { /* ignore */ }
        } else if (isCriteriaItem(o)) {
          _name = 'Any token'
        }
        return { ...o, itemType: it, _name, _image }
      }))

      const considerationItems = await Promise.all(params.consideration.map(async (c) => {
        const it = Number(c.itemType)
        let _name = null, _image = null
        if (it === ItemType.ERC721 || it === ItemType.ERC1155) {
          try {
            const meta = await fetchMetadata(cid, c.token, c.identifierOrCriteria, it === 3 ? 1 : 0)
            _name = meta?.name
            _image = meta?.image
          } catch { /* ignore */ }
        } else if (isCriteriaItem(c)) {
          _name = 'Any token'
        }
        return { ...c, itemType: it, _name, _image }
      }))

      // Preload images for canvas
      await preloadAssetImages(offerItems, cid)
      await preloadAssetImages(considerationItems, cid)

      // Resolve ENS names
      const [makerENS, takerENS] = await Promise.all([
        resolveENS(params.offerer),
        resolveENS(effectiveTaker),
      ])

      if (cancelled) return

      const blob = await generateTradeImage({
        maker: params.offerer,
        makerENS,
        taker: effectiveTaker,
        takerENS,
        chainId: cid,
        offerItems,
        considerationItems,
      })

      if (!cancelled && blob) {
        setShareImageBlob(blob)
        setShareImageUrl(URL.createObjectURL(blob))
      }
    })().finally(() => {
      if (!cancelled) setGeneratingImage(false)
    })

    return () => {
      cancelled = true
    }
  }, [orderData, statusLabel, chainId, fulfiller])

  // Clean up object URL
  useEffect(() => {
    return () => { if (shareImageUrl) URL.revokeObjectURL(shareImageUrl) }
  }, [shareImageUrl])

  // Check holdings when order is loaded and open
  useEffect(() => {
    if (!orderData || statusLabel !== 'open') return
    let cancelled = false
    const params = orderData.order.parameters
    setOfferHoldings(null)
    setOfferApprovals(null)
    setConsiderationHoldings(null)

    const { items: resolvedOffer, missing: missingOffer } = resolveCriteriaItems(params.offer, criteriaSelections.offer)
    const { items: resolvedConsideration, missing: missingConsideration } = resolveCriteriaItems(params.consideration, criteriaSelections.consideration)

    // Check maker holds offered assets
    checkHoldings(Number(chainId), params.offerer, resolvedOffer).then((results) => {
      const withMissing = applyMissingCriteria(results, missingOffer)
      if (!cancelled) setOfferHoldings(withMissing)
    })

    // Check maker has approved Seaport to transfer offered assets
    checkSeaportApprovals(Number(chainId), params.offerer, params.offer).then((results) => {
      if (!cancelled) setOfferApprovals(results)
    })

    // Check taker holds consideration assets (only if wallet is the valid taker)
    const takerAddr = orderData.taker
    const isValidTaker = wallet && (
      takerAddr === ZERO_ADDRESS ||
      wallet.address.toLowerCase() === takerAddr.toLowerCase()
    )
    if (isValidTaker) {
      checkHoldings(Number(chainId), wallet.address, resolvedConsideration).then((results) => {
        const withMissing = applyMissingCriteria(results, missingConsideration)
        if (!cancelled) setConsiderationHoldings(withMissing)
      })
    } else {
      setConsiderationHoldings(null)
    }

    return () => { cancelled = true }
  }, [orderData, statusLabel, chainId, wallet, criteriaSelections])

  // Preload the taker's USDC headroom for optional support tips.
  useEffect(() => {
    if (!orderData || statusLabel !== 'open') {
      setSupportTipBalance(null)
      setSupportTipBalanceStatus('idle')
      setSupportTipRequiredUSDC(0n)
      setSupportTipAmountInput('0')
      return
    }

    const params = orderData.order.parameters
    const takerAddr = orderData.taker
    const isValidTaker = wallet && (
      takerAddr === ZERO_ADDRESS ||
      wallet.address.toLowerCase() === takerAddr.toLowerCase()
    )
    const tipToken = supportTipToken(chainId)

    if (!isValidTaker || !tipToken) {
      setSupportTipBalance(null)
      setSupportTipBalanceStatus('idle')
      setSupportTipRequiredUSDC(0n)
      setSupportTipAmountInput('0')
      return
    }

    let cancelled = false
    const requiredUSDC = requiredSupportTipTokenConsideration(params.consideration, chainId)
    setSupportTipBalance(null)
    setSupportTipRequiredUSDC(requiredUSDC)
    setSupportTipBalanceStatus('checking')

    ;(async () => {
      try {
        const chain = CHAINS[Number(chainId)]
        if (!chain) throw new Error('Unsupported chain')
        const provider = new JsonRpcProvider(chain.rpcUrl)
        const contract = new Contract(tipToken.address, ERC20_BALANCE_ABI, provider)
        const balance = await contract.balanceOf(wallet.address)
        if (cancelled) return
        const available = balance > requiredUSDC ? balance - requiredUSDC : 0n
        const prefill = available < SUPPORT_TIP_DEFAULT_USDC_UNITS ? 0n : SUPPORT_TIP_DEFAULT_USDC_UNITS
        setSupportTipBalance(balance)
        setSupportTipAmountInput(formatSupportTipUnits(prefill, chainId))
        if (prefill === 0n) setSupportOcarina(false)
        setSupportTipBalanceStatus('ready')
      } catch (err) {
        console.error('Failed to load support tip balance:', err)
        if (!cancelled) setSupportTipBalanceStatus('error')
      }
    })()

    return () => { cancelled = true }
  }, [orderData, statusLabel, chainId, wallet?.address])

  useEffect(() => {
    if (!supportOcarina || !orderData || supportTipBalanceStatus !== 'ready' || supportTipBalance === null) return

    const amount = parseSupportTipAmount(supportTipAmountInput, chainId)
    const max = supportTipBalance > supportTipRequiredUSDC ? supportTipBalance - supportTipRequiredUSDC : 0n

    if (max <= 0n) {
      setSupportTipAmountInput('0')
      setSupportOcarina(false)
      return
    }
    if (amount !== null && amount > max) {
      setSupportTipAmountInput(formatSupportTipUnits(max, chainId))
    }
  }, [supportOcarina, supportTipAmountInput, supportTipBalance, supportTipRequiredUSDC, supportTipBalanceStatus, chainId, orderData])

  async function checkVerificationAndFill() {
    if (!orderData) return
    const params = orderData.order.parameters
    // Only check NFTs the taker is receiving (maker's offer items), not what they're giving
    const nftItems = params.offer.filter((item) => {
      const it = Number(item.itemType)
      return it === 2 || it === 3 || it === 4 || it === 5
    })

    const unverified = []
    for (const item of nftItems) {
      const v = await getVerificationStatus(Number(chainId), item.token)
      if (v.status !== 'verified') {
        let name = null
        try {
          const tokenId = isCriteriaItem(item) ? criteriaSelections.offer?.[params.offer.indexOf(item)] : item.identifierOrCriteria
          const meta = tokenId
            ? await fetchMetadata(Number(chainId), item.token, tokenId, Number(item.itemType) === 3 || Number(item.itemType) === 5 ? 1 : 0)
            : null
          name = meta?.name
        } catch { /* ignore */ }
        const openseaChain = { 1: 'ethereum', 8453: 'base', 137: 'matic', 57073: 'ink' }[Number(chainId)] || 'ethereum'
        const tokenId = isCriteriaItem(item) ? criteriaSelections.offer?.[params.offer.indexOf(item)] : item.identifierOrCriteria
        unverified.push({
          token: item.token,
          tokenId,
          name: name || (tokenId ? `#${tokenId}` : 'Any token from collection'),
          status: v.status,
          message: v.message,
          openseaUrl: tokenId ? `https://opensea.io/assets/${openseaChain}/${item.token}/${tokenId}` : `https://opensea.io/assets/${openseaChain}/${item.token}`,
        })
      }
    }

    if (unverified.length > 0) {
      setUnverifiedAssets(unverified)
      setShowVerifyModal(true)
    } else {
      handleFill()
    }
  }

  const handleFill = useCallback(async () => {
    if (!wallet || !orderData) return
    setError(null)
    setSubmitting(true)

    const params = orderData.order.parameters
    let includeSupportTip = supportOcarina
    let parsedSupportTipAmount = includeSupportTip ? parseSupportTipAmount(supportTipAmountInput, chainId) : null
    const supportTipMax = supportTipBalance === null ? null : (
      supportTipBalance > supportTipRequiredUSDC ? supportTipBalance - supportTipRequiredUSDC : 0n
    )

    if (includeSupportTip) {
      if (parsedSupportTipAmount === null || parsedSupportTipAmount <= 0n) {
        setSupportOcarina(false)
        includeSupportTip = false
        parsedSupportTipAmount = null
      } else if (supportTipMax !== null && parsedSupportTipAmount > supportTipMax) {
        setSupportTipAmountInput(formatSupportTipUnits(supportTipMax, chainId))
        if (supportTipMax <= 0n) {
          setSupportOcarina(false)
          includeSupportTip = false
          parsedSupportTipAmount = null
        } else {
          parsedSupportTipAmount = supportTipMax
        }
      }
    }

    const supportTip = includeSupportTip ? supportTipForChain(chainId, parsedSupportTipAmount) : null
    // Build taker assets from consideration items
    const takerAssets = params.consideration.map((c) => {
      const it = Number(c.itemType)
      return {
        token: c.token,
        tokenId: c.identifierOrCriteria,
        amount: c.startAmount,
        assetType: it === ItemType.NATIVE ? 'NATIVE' :
                   it === ItemType.ERC20 ? 'ERC20' :
                   it === ItemType.ERC1155 ? 'ERC1155' : 'ERC721',
        itemType: it,
      }
    })
    if (supportTip) takerAssets.push(supportTipAsset(chainId, supportTip.amount))

    const txSteps = buildSteps(takerAssets, 'Check Fillability', supportTip ? 'Sign Support Tip' : null, 'Accept Offer')
    setSteps(txSteps)

    function updateStep(index, update) {
      txSteps[index] = { ...txSteps[index], ...update }
      setSteps([...txSteps])
    }

    try {
      const approvalSteps = txSteps.filter((s) => s.type === 'approval')
      for (let i = 0; i < approvalSteps.length; i++) {
        const step = approvalSteps[i]
        const stepIndex = txSteps.indexOf(step)
        updateStep(stepIndex, { status: 'signing' })

        const matchingAssets = takerAssets.filter((a) => a.token && a.token.toLowerCase() === step.tokenAddress.toLowerCase())
        const asset = matchingAssets[0]
        // Sum amounts for ERC-20 in case multiple consideration items use the same token
        const totalAmount = asset?.itemType === ItemType.ERC20
          ? matchingAssets.reduce((sum, a) => sum + BigInt(a.amount), 0n).toString()
          : undefined
        const tx = await ensureApproval(wallet.provider, step.tokenAddress, wallet.address, asset?.itemType ?? ItemType.ERC721, totalAmount)
        if (tx) {
          updateStep(stepIndex, { status: 'confirming' })
          await tx.wait()
        }
        updateStep(stepIndex, { status: 'done' })
      }

      const tips = supportTip ? [supportTip] : []
      const simulationIndex = txSteps.findIndex((s) => s.label === 'Check Fillability')
      updateStep(simulationIndex, { status: 'checking' })
      await simulateFulfillment(
        wallet.provider,
        Number(chainId),
        orderData.orderHash,
        orderData.order,
        criteriaSelections,
        [],
        '0x'
      )
      updateStep(simulationIndex, { status: 'done' })

      let tipAuthorization = '0x'
      if (supportTip) {
        const tipIndex = txSteps.findIndex((s) => s.label === 'Sign Support Tip')
        updateStep(tipIndex, { status: 'signing' })
        tipAuthorization = await signTipAuthorization(
          wallet.provider,
          Number(chainId),
          orderData.zoneAddress,
          orderData.orderHash,
          tips
        )
        updateStep(tipIndex, { status: 'done' })
      }

      const actionIndex = txSteps.findIndex((s) => s.label === 'Accept Offer')
      updateStep(actionIndex, { status: 'signing' })
      const { wait } = await fulfillOrder(
        wallet.provider,
        Number(chainId),
        orderData.orderHash,
        orderData.order,
        criteriaSelections,
        tips,
        tipAuthorization
      )
      updateStep(actionIndex, { status: 'confirming' })
      const receipt = await wait()
      updateStep(actionIndex, { status: 'done' })

      setFillTxHash(receipt.hash)
      setStatusLabel('filled')
    } catch (err) {
      console.error(err)
      const msg = friendlyFillError(err)
      const failedIndex = txSteps.findIndex((s) => s.status === 'checking' || s.status === 'signing' || s.status === 'confirming')
      if (failedIndex !== -1) {
        updateStep(failedIndex, { status: 'failed', error: msg })
      }
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }, [wallet, orderData, criteriaSelections, chainId, supportOcarina, supportTipAmountInput, supportTipBalance, supportTipRequiredUSDC, supportTipBalanceStatus])

  const handleCancel = useCallback(async () => {
    if (!wallet || !orderData) return
    setError(null)
    setSubmitting(true)

    const txSteps = [{ label: 'Cancel Order', status: 'pending', type: 'action' }]
    setSteps(txSteps)

    function updateStep(index, update) {
      txSteps[index] = { ...txSteps[index], ...update }
      setSteps([...txSteps])
    }

    try {
      updateStep(0, { status: 'signing' })
      const { wait } = await cancelOrder(wallet.provider, orderData.order.parameters)
      updateStep(0, { status: 'confirming' })
      await wait()
      updateStep(0, { status: 'done' })

      setStatusLabel('cancelled')
    } catch (err) {
      console.error(err)
      const msg = friendlyFillError(err)
      updateStep(0, { status: 'failed', error: msg })
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }, [wallet, orderData])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  if (loadError) {
    return (
      <div className="page offer-detail">
        <h1>Invalid Offer</h1>
        <p className="form-error">{loadError}</p>
      </div>
    )
  }

  if (!orderData) return <div className="page offer-detail"><p className="text-muted">Loading order...</p></div>

  const params = orderData.order.parameters
  const maker = params.offerer
  const taker = orderData.taker
  const isExpired = statusLabel === 'expired'
  const isMaker = wallet && wallet.address.toLowerCase() === maker.toLowerCase()
  const effectiveTaker = fulfiller || taker
  const isTaker = wallet && (
    (taker === ZERO_ADDRESS && !fulfiller) ||
    wallet.address.toLowerCase() === effectiveTaker.toLowerCase()
  )
  const isOpen = statusLabel === 'open'
  const isRestricted = taker !== ZERO_ADDRESS
  const wrongTaker = wallet && isRestricted && !isTaker
  const wrongChain = wallet && wallet.chainId !== Number(chainId)
  const makerMissing = offerHoldings && offerHoldings.some((h) => !h.held)
  const makerApprovalMissing = offerApprovals && offerApprovals.some((a) => !a.approved)
  const takerMissing = considerationHoldings && considerationHoldings.some((h) => !h.held)
  const supportTipAvailable = Boolean(supportTipToken(chainId))
  const supportTipAmount = supportTipAvailable ? parseSupportTipAmount(supportTipAmountInput, chainId) : null
  const supportTipMax = supportTipBalance === null ? null : (
    supportTipBalance > supportTipRequiredUSDC ? supportTipBalance - supportTipRequiredUSDC : 0n
  )
  const supportTipMaxLabel = supportTipMax !== null ? formatSupportTipUnits(supportTipMax, chainId) : null
  const supportTipChecking = supportOcarina && supportTipAvailable && supportTipBalanceStatus !== 'ready' && supportTipBalanceStatus !== 'error'
  const supportTipMissing = supportOcarina && supportTipAmount !== null && supportTipAmount > 0n && supportTipMax !== null && supportTipAmount > supportTipMax
  const supportTipUnavailable = supportTipBalanceStatus === 'ready' && supportTipMax === 0n
  const supportTipCheckboxDisabled = submitting || supportTipBalanceStatus === 'checking' || supportTipUnavailable
  const fillabilityChecking = isOpen && (!offerHoldings || !offerApprovals)
  const fillabilityBlocked = makerMissing || makerApprovalMissing
  const missingCriteria = hasMissingCriteria(params, criteriaSelections)
  const duplicateERC721Criteria = hasDuplicateERC721CriteriaSelections(params, criteriaSelections)

  // Parse offer/consideration for display (format fungible amounts to human-readable)
  function formatAmount(item) {
    const it = Number(item.itemType)
    if (it === ItemType.NATIVE) return formatTokenAmount(formatUnits(item.startAmount, 18))
    if (it === ItemType.ERC20) {
      const info = (WHITELISTED_ERC20[Number(chainId)] || {})[item.token]
      return formatTokenAmount(formatUnits(item.startAmount, info?.decimals ?? 18))
    }
    return item.startAmount
  }

  const offerAssets = params.offer.map((o) => ({
    token: o.token,
    tokenId: o.identifierOrCriteria,
    amount: formatAmount(o),
    itemType: Number(o.itemType),
    criteriaSelection: criteriaSelections.offer?.[params.offer.indexOf(o)],
  }))
  const considerationAssets = params.consideration.map((c) => ({
    token: c.token,
    tokenId: c.identifierOrCriteria,
    amount: formatAmount(c),
    itemType: Number(c.itemType),
    criteriaSelection: criteriaSelections.consideration?.[params.consideration.indexOf(c)],
  }))

  function setCriteriaSelection(side, index, value) {
    setCriteriaSelections((prev) => ({
      ...prev,
      [side]: { ...prev[side], [index]: value.trim() },
    }))
  }

  function handleSupportTipToggle(e) {
    const checked = e.target.checked
    if (!checked) {
      setSupportOcarina(false)
      return
    }
    if (supportTipBalanceStatus === 'ready' && supportTipMax !== null && supportTipMax <= 0n) {
      setSupportOcarina(false)
      return
    }
    if (supportTipAmount === null || supportTipAmount <= 0n) {
      const amount = supportTipMax !== null && supportTipMax < SUPPORT_TIP_DEFAULT_USDC_UNITS
        ? supportTipMax
        : SUPPORT_TIP_DEFAULT_USDC_UNITS
      setSupportTipAmountInput(formatSupportTipUnits(amount, chainId))
    }
    setSupportOcarina(true)
  }

  function handleSupportTipAmountChange(e) {
    const value = e.target.value
    if (hasTooManySupportTipDecimals(value, chainId)) return
    const amount = parseSupportTipAmount(value, chainId)
    if (amount !== null && supportTipMax !== null && amount > supportTipMax) {
      setSupportTipAmountInput(formatSupportTipUnits(supportTipMax, chainId))
      return
    }
    setSupportTipAmountInput(value)
    if (supportOcarina && (value.trim() === '' || amount === null || amount <= 0n)) {
      setSupportOcarina(false)
    }
  }

  return (
    <div className="page offer-detail">
      <h1>Offer Details</h1>

      <div className="offer-status-bar">
        {statusLoading ? (
          <span className="status-loading">Loading status...</span>
        ) : (
          <span className={`status-badge status-${statusLabel}`}>
            {statusLabel}
          </span>
        )}
        <button className="btn btn-secondary btn-sm" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy Link'}
        </button>
      </div>

      <div className="offer-parties">
        <div className="offer-party">
          <h3 className="party-address">
            From <AddressDisplay address={maker} chainId={Number(chainId)} />
            {isMaker && <span className="you-badge">you</span>}
          </h3>
          <AssetList
            assets={offerAssets}
            chainId={chainId}
            holdings={offerHoldings}
            approvals={offerApprovals}
            holdingsLabel="Maker"
            criteriaSide="offer"
            criteriaSelections={criteriaSelections.offer}
            onCriteriaChange={setCriteriaSelection}
          />
        </div>
        <div className="offer-party">
          <h3 className="party-address">
            {taker === ZERO_ADDRESS && !fulfiller ? (
              <>From Anyone</>
            ) : (
              <>
                From <AddressDisplay address={fulfiller || taker} chainId={Number(chainId)} />
                {isTaker && <span className="you-badge">you</span>}
              </>
            )}
          </h3>
          <AssetList
            assets={considerationAssets}
            chainId={chainId}
            holdings={isMaker ? null : considerationHoldings}
            holdingsLabel="You"
            criteriaSide="consideration"
            criteriaSelections={criteriaSelections.consideration}
            onCriteriaChange={setCriteriaSelection}
          />
        </div>
      </div>

      {isOpen && !fillabilityChecking && fillabilityBlocked && (
        <div className="fillability-panel fillability-panel-blocked">
          {makerMissing && (
            <p>The maker no longer holds all offered assets.</p>
          )}
          {makerApprovalMissing && (
            <p>The maker has not approved Seaport to transfer all offered assets.</p>
          )}
        </div>
      )}

      <div className="offer-meta">
        {statusLabel === 'open' && params.endTime && Number(params.endTime) > 0 && (() => {
          const expiryMs = Number(params.endTime) * 1000
          const expiryDate = new Date(expiryMs)
          const hoursLeft = (expiryMs - Date.now()) / (1000 * 60 * 60)
          const soon = hoursLeft > 0 && hoursLeft <= 48
          const label = soon
            ? expiryDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
            : expiryDate.toLocaleDateString(undefined, { dateStyle: 'medium' })
          return (
            <p className={soon ? 'text-danger' : ''}>
              <span className="meta-label">Expires:</span> {label}
              {isExpired && ' (expired)'}
            </p>
          )
        })()}
        {(orderData.resolution?.txHash || fillTxHash) && (() => {
          const hash = orderData.resolution?.txHash || fillTxHash
          const label = orderData.resolution?.type === 'cancel' ? 'Cancel tx' : 'Fill tx'
          const url = getExplorerTxUrl(chainId, hash)
          return (
            <p>
              <span className="meta-label">{label}:</span>{' '}
              <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
            </p>
          )
        })()}
        {orderData.memo && (() => {
          const multiline = orderData.memo.includes('\n')
          return (
            <div className="offer-memo">
              <span className="meta-label">Memo:</span>
              {multiline
                ? <div style={{ whiteSpace: 'pre-wrap', paddingLeft: '1rem', marginTop: '0.25rem' }}>{orderData.memo}</div>
                : <> {orderData.memo}</>
              }
            </div>
          )
        })()}
      </div>

      {statusLabel === 'filled' && (isMaker || isTaker) && (
        <div className="share-section">
          {shareImageUrl && (
            <div className="share-preview">
              <img src={shareImageUrl} alt="Trade summary" />
            </div>
          )}
          {generatingImage && <p className="text-muted">Generating share image...</p>}
          <div className="share-buttons">
            <a
              className="btn btn-primary btn-sm"
              href={`https://x.com/intent/tweet?text=${encodeURIComponent('I just struck a deal on @ocarinatrade! 🤝')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Share on X
            </a>
            {shareImageBlob && navigator.clipboard?.write && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.write([
                      new ClipboardItem({ 'image/png': shareImageBlob })
                    ])
                  } catch { /* fallback silently */ }
                }}
              >
                Copy Image
              </button>
            )}
            {shareImageBlob && (
              <a
                className="btn btn-secondary btn-sm"
                href={shareImageUrl}
                download={`ocarina-trade-${chainId}-${txHash.slice(0, 10)}.png`}
              >
                Save Image
              </a>
            )}
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      {!wallet && isOpen && (
        <p className="text-muted">Connect your wallet to accept or cancel this offer.</p>
      )}

      {wallet && wrongChain && isOpen && (
        <div className="form-error">
          Switch your wallet to {CHAINS[Number(chainId)]?.name || `chain ${chainId}`} to interact with this offer.
          <button
            className="btn btn-sm"
            style={{ marginLeft: '0.75rem' }}
            onClick={async () => {
              const cid = Number(chainId)
              const hexChainId = '0x' + cid.toString(16)
              const chain = CHAINS[cid]
              try {
                await wallet.provider.request({
                  method: 'wallet_addEthereumChain',
                  params: [{
                    chainId: hexChainId,
                    chainName: chain?.name || `Chain ${cid}`,
                    nativeCurrency: { name: 'Ether', symbol: chain?.nativeSymbol || 'ETH', decimals: 18 },
                    rpcUrls: [chain?.rpcUrl],
                    blockExplorerUrls: chain?.blockscoutApi ? [chain.blockscoutApi.replace(/\/api\/?$/, '')] : undefined,
                  }],
                })
              } catch {}
            }}
            type="button"
          >
            Switch Network
          </button>
        </div>
      )}

      {wallet && !wrongChain && isOpen && !isExpired && wrongTaker && !isMaker && (
        <p className="form-error">This offer is restricted to a specific taker. Your connected wallet is not the authorized taker.</p>
      )}

      {wallet && !wrongChain && isOpen && !isExpired && isTaker && !isMaker && (() => {
        const blocked = fillabilityChecking || fillabilityBlocked || takerMissing || supportTipChecking || supportTipMissing || missingCriteria || duplicateERC721Criteria
        return (
          <>
            {makerMissing && (
              <p className="form-error">This offer cannot be accepted — the maker no longer holds all offered assets.</p>
            )}
            {makerApprovalMissing && (
              <p className="form-error">This offer cannot be accepted — the maker has not approved Seaport to transfer all offered assets.</p>
            )}
            {takerMissing && (
              <p className="form-error">You do not hold all required assets to accept this offer.</p>
            )}
            {missingCriteria && (
              <p className="form-error">Choose a token ID for each Any Token item before accepting this offer.</p>
            )}
            {duplicateERC721Criteria && (
              <p className="form-error">Each ERC-721 Any Token item must use a different token ID.</p>
            )}
            <div className="offer-actions">
              {supportTipAvailable && (
                <>
                  <div className="support-tip-control">
                    <label className="support-tip-checkbox">
                      <input
                        type="checkbox"
                        checked={supportOcarina}
                        onChange={handleSupportTipToggle}
                        disabled={supportTipCheckboxDisabled}
                      />
                      <span>Support Ocarina</span>
                    </label>
                    <div className="support-tip-amount">
                      <input
                        className="support-tip-input"
                        type="text"
                        inputMode="decimal"
                        value={supportTipAmountInput}
                        onChange={handleSupportTipAmountChange}
                        disabled={submitting || supportTipBalanceStatus === 'checking' || supportTipUnavailable}
                        aria-label="Support tip amount"
                      />
                      <span>USDC</span>
                    </div>
                  </div>
                  {supportTipBalanceStatus === 'checking' && (
                    <p className="support-tip-hint">Checking available USDC...</p>
                  )}
                  {supportTipBalanceStatus === 'ready' && supportTipMaxLabel !== null && (
                    <p className="support-tip-hint">Available for tip: {supportTipMaxLabel} USDC</p>
                  )}
                  {supportTipBalanceStatus === 'error' && (
                    <p className="support-tip-hint">Balance unavailable; enter tip manually.</p>
                  )}
                </>
              )}
              <button className="btn btn-primary" onClick={checkVerificationAndFill} disabled={submitting || blocked}>
                {submitting ? 'Accepting...' : 'Accept Offer'}
              </button>
              <TxChecklist steps={steps} />
            </div>
          </>
        )
      })()}

      {wallet && !wrongChain && isOpen && isMaker && (
        <div className="offer-actions">
          <button className="btn btn-cancel" onClick={handleCancel} disabled={submitting}>
            {submitting ? 'Cancelling...' : 'Cancel Offer'}
          </button>
          <TxChecklist steps={steps} />
        </div>
      )}

      {showVerifyModal && (
        <div className="modal-overlay" onClick={() => setShowVerifyModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Unverified Assets</h3>
            <p>The following assets could not be verified. Review them on OpenSea to confirm they are the real assets before proceeding.</p>
            <div className="modal-asset-list">
              {unverifiedAssets.map((a, i) => (
                <div key={i} className="modal-asset-row">
                  <span className="modal-asset-name">{a.name}</span>
                  <a href={a.openseaUrl} target="_blank" rel="noopener noreferrer" className="btn-link btn-sm">
                    View on OpenSea
                  </a>
                  {a.status === 'suspicious' && a.message && (
                    <p className="text-danger" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0' }}>{a.message}</p>
                  )}
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowVerifyModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { setShowVerifyModal(false); handleFill() }}>
                Accept Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AssetList({ assets, chainId, holdings, approvals, holdingsLabel, criteriaSide, criteriaSelections, onCriteriaChange }) {
  return (
    <div className="asset-list">
      {assets.map((asset, i) => (
        <div key={i}>
          <AssetCard asset={asset} chainId={Number(chainId)} compact={false} />
          {isCriteriaItem(asset) && (
            <label className="criteria-resolver">
              <span>{criteriaSide === 'offer' ? 'Token ID to receive' : 'Token ID to send'}</span>
              <input
                type="text"
                value={criteriaSelections?.[i] || ''}
                onChange={(e) => onCriteriaChange?.(criteriaSide, i, e.target.value)}
                placeholder="Token ID"
              />
            </label>
          )}
          {holdings && !holdings[i]?.held && (
            <p className="asset-missing">{holdings[i]?.reason === 'Choose token ID' ? 'Choose a token ID for this item' : `${holdingsLabel} ${holdingsLabel === 'You' ? 'do' : 'does'} not hold this asset`}</p>
          )}
          {approvals && !approvals[i]?.approved && (
            <p className="asset-missing">{holdingsLabel} has not approved Seaport for this asset</p>
          )}
        </div>
      ))}
    </div>
  )
}
