import { useState, useEffect, useCallback } from 'react'
import { fetchCollections, fetchNFTsForContract } from '../../lib/alchemy'
import { fetchMetadata } from '../../lib/metadata'
import { WHITELISTED_ERC20, CHAINS } from '../../lib/constants'
import verifiedTokens from '../../data/verified-tokens.json'
import mergedCollections from '../../data/merged-collections.json'
import { Contract, JsonRpcProvider, formatUnits } from 'ethers'

const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']
const ERC165_ABI = ['function supportsInterface(bytes4 interfaceId) view returns (bool)']

// Local fallback images for merged collections
const COLLECTION_IMAGES = {
  '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401': new URL('../../assets/collections/ens.png', import.meta.url).href,
}

/**
 * Build lookup maps from merged-collections.json.
 * aliasToCanonical: alias address → canonical (primary) address
 * canonicalMeta: canonical address → { name, aliases }
 */
function buildMergedLookups(chainId) {
  const chainMerges = mergedCollections[String(chainId)] || {}
  const aliasToCanonical = {}
  const canonicalMeta = {}
  for (const [canonical, meta] of Object.entries(chainMerges)) {
    const canonLower = canonical.toLowerCase()
    canonicalMeta[canonLower] = meta
    for (const alias of meta.aliases || []) {
      aliasToCanonical[alias.toLowerCase()] = canonLower
    }
  }
  return { aliasToCanonical, canonicalMeta }
}

// Patterns that strongly indicate spam NFT collections
const SPAM_PATTERNS = [
  // URLs in names (e.g. "blazeETH.com", "layerzero.pl", "daoevent_com")
  /\b[a-z0-9-]+\.(com|net|org|io|xyz|co|cc|gg|me|pro|site|club|app|win|top|vip|fun|click|link|shop|trade|us|pl|lat|gift|finance|info)\b/i,
  /_(com|net|org|io|xyz)\b/i,
  // URL shorteners and telegram links
  /\bt\.ly\/|t\.me\/|bit\.ly\/|tinyurl\./i,
  // Claim/reward/gift bait language
  /\b(claim|reward|voucher|airdrop|free mint|activate|visit\s|eligible|bonus|lottery|giveaway|whitelist|invite)\b/i,
  // Unicode bait emojis (✅, ❗, 💰, etc.)
  /[✅❗⚡️🎁💰🔥⭐️🎉❓✔️↪️]/,
  // Dollar sign before or after numbers ("$5000", "2000$ USDC", "$PENDLE")
  /\$\s?\d|\d+\s?\$/,
  // Token/crypto amounts ("5000 BUSD", "700M SHIB", "1 stETH", "1.2827 cbETH")
  /\b\d[\d,.]*[MKB]?\s+(USD|ETH|MATIC|USDC|USDT|BUSD|SHIB|UNI|COMP|stETH|cbETH|BRETT|PENDLE|DEGEN|CAKE)\b/i,
  // "$TOKEN" pattern in collection names (e.g. "1.000.000 $PENDLE")
  /\$[A-Z]{2,}/,
  // Fake amounts with letter O instead of 0 ("5O,OOO USD")
  /\d+O[,.]?O+/,
  // "X by Y" where Y is a known protocol (fake airdrops: "5 ETH by Base")
  /\bby\s+(Base|Uniswap|Lido|Optimism|Arbitrum|Aave|Compound)\b/i,
  // Exclamation-heavy spam ("!!! 250 COMP", "!STOLEN CRYPTO")
  /^!+\s*[A-Z0-9]/,
  // NFT TICKETS pattern
  /\bNFT\s+(TICKET|TICKETS)\b/i,
  // "FOR FREE" bait
  /\bFOR\s+FREE\b/i,
  // QR code scams
  /\bQR\b/i,
  // Fake protocol events ("dYdX Event", "Uniswap NFT Event", "BLUR EVENT")
  /\b(Exchange|Token|NFT|Summer|Plus)?\s*Event\b/i,
  // Scare tactics ("AML high risk", "STOLEN CRYPTO")
  /\b(AML|STOLEN|BLOCKED|FROZEN|RISK)\b/i,
  // "Unidentified contract" or bare EVM address as name
  /^Unidentified contract\b/,
  /^0x[0-9a-fA-F]{40}$/,
  // Impersonation of blue-chip collections (exact name + token ID pattern)
  /^CryptoPunk #\d+$/,
  // Fake protocol branding + whitelist/invite
  /\b(LIDO|OPTIMISM|ARBITRUM)\s+(WHITELIST|NFT)\b/i,
  // "FREESPIN" / free spin gambling bait
  /\bFREE\s?SPIN\b/i,
]

/**
 * Heuristic spam detection based on collection name patterns.
 * Only applied to unverified collections. Conservative to avoid false positives.
 */
function looksLikeSpam(name) {
  if (!name) return false
  return SPAM_PATTERNS.some((re) => re.test(name))
}

/**
 * Normalize a collection from the getContractsForOwner API response.
 * Applies heuristic spam detection on top of the API's isSpam flag.
 */
function normalizeCollection(col, chainId) {
  const chainTokens = verifiedTokens[String(chainId)] || {}
  const inStaticList = Object.keys(chainTokens).some((a) => a.toLowerCase() === col.address?.toLowerCase())
  const isVerified = inStaticList || col.safelistStatus === 'verified' || col.safelistStatus === 'approved'
  let isSpam = col.isSpam || false
  // Verified collections are never spam; heuristic catches what API misses
  if (isVerified) {
    isSpam = false
  } else if (!isSpam && looksLikeSpam(col.name)) {
    isSpam = true
  }
  return {
    name: col.name || col.address.slice(0, 6) + '...' + col.address.slice(-4),
    thumbnail: col.image || col.collectionImage || null,
    tokenType: col.tokenType,
    tokenCount: col.numDistinctTokensOwned,
    totalBalance: col.totalBalance,
    isSpam,
    isVerified,
  }
}

/**
 * Apply overrides from merged-collections config onto a collection entry.
 */
function applyMergedMeta(col, meta, canonicalAddr) {
  if (!meta) return
  if (meta.name) col.name = meta.name
  const localImg = COLLECTION_IMAGES[canonicalAddr]
  if (localImg) col.thumbnail = col.thumbnail || localImg
  if (meta.verified) { col.isVerified = true; col.isSpam = false }
  col._aliases = meta.aliases?.map((a) => a.toLowerCase()) || []
}

/**
 * Merge alias collections into their canonical entry.
 * Mutates the collections object: removes alias keys, combines counts into canonical.
 */
function applyCollectionMerges(cols, chainId) {
  const { aliasToCanonical, canonicalMeta } = buildMergedLookups(chainId)
  for (const addr of Object.keys(cols)) {
    const canonical = aliasToCanonical[addr]
    if (!canonical) continue
    // Merge into canonical entry (create if not present yet)
    if (cols[canonical]) {
      cols[canonical].tokenCount = String(
        (Number(cols[canonical].tokenCount) || 0) + (Number(cols[addr].tokenCount) || 0)
      )
      cols[canonical].totalBalance = String(
        (Number(cols[canonical].totalBalance) || 0) + (Number(cols[addr].totalBalance) || 0)
      )
      // Prefer existing thumbnail, fall back to alias thumbnail
      cols[canonical].thumbnail = cols[canonical].thumbnail || cols[addr].thumbnail
    } else {
      cols[canonical] = { ...cols[addr] }
    }
    // Apply canonical metadata overrides
    const meta = canonicalMeta[canonical]
    applyMergedMeta(cols[canonical], meta, canonical)
    delete cols[addr]
  }
  // Also apply overrides if canonical exists but no alias was seen
  for (const [addr, col] of Object.entries(cols)) {
    const meta = canonicalMeta[addr]
    if (meta && !col._aliases) applyMergedMeta(col, meta, addr)
  }
}

/**
 * Sort collection entries: verified first, then named, then unnamed.
 * Within each tier, sort by number of tokens owned (descending).
 */
function sortCollectionEntries(entries) {
  return entries.sort(([, a], [, b]) => {
    const scoreA = a.isVerified ? 0 : (a.name && !a.name.includes('...')) ? 1 : 2
    const scoreB = b.isVerified ? 0 : (b.name && !b.name.includes('...')) ? 1 : 2
    if (scoreA !== scoreB) return scoreA - scoreB
    // Within same tier, more tokens owned = higher priority
    return (Number(b.tokenCount) || 0) - (Number(a.tokenCount) || 0)
  })
}

/**
 * Asset picker with Collectibles and Cash tabs.
 * Supports multi-select for NFTs and amount entry for ERC-20s.
 *
 * Props:
 *   address     — wallet address to enumerate holdings for
 *   chainId     — chain to query
 *   selected    — current array of selected assets
 *   onChange    — called with updated array
 *   showNative  — whether to show native ETH in cash tab (taker side only)
 *   isOwnWallet — true if this is the connected user's wallet (for loading NFTs)
 */
export default function AssetPicker({ address, chainId, selected, onChange, showNative = false, isOwnWallet = true, dimZeroBalance = true, backRef }) {
  const [tab, setTab] = useState('collectibles')

  return (
    <div className="asset-picker">
      <div className="asset-picker-tabs">
        <button
          type="button"
          className={`tab${tab === 'collectibles' ? ' active' : ''}`}
          onClick={() => setTab('collectibles')}
        >
          Collectibles
        </button>
        <button
          type="button"
          className={`tab${tab === 'cash' ? ' active' : ''}`}
          onClick={() => setTab('cash')}
        >
          Cash
        </button>
      </div>

      {tab === 'collectibles' && (
        <CollectiblesTab
          address={address}
          chainId={chainId}
          selected={selected}
          onChange={onChange}
          isOwnWallet={isOwnWallet}
          backRef={backRef}
        />
      )}
      {tab === 'cash' && (
        <CashTab
          address={address}
          chainId={chainId}
          selected={selected}
          onChange={onChange}
          showNative={showNative}
          isOwnWallet={isOwnWallet}
          dimZeroBalance={dimZeroBalance}
        />
      )}
    </div>
  )
}

// ── Collectibles Tab ──────────────────────────────────────────────

const OPENSEA_CHAINS = { 1: 'ethereum', 8453: 'base', 137: 'matic', 57073: 'ink' }
const openseaLogo = new URL('../../assets/opensea.svg', import.meta.url).href

function CollectiblesTab({ address, chainId, selected, onChange, isOwnWallet, backRef }) {
  const [collections, setCollections] = useState({}) // { contractAddr: normalizedCol }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [pageKey, setPageKey] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [paginationBroken, setPaginationBroken] = useState(false)
  const [filter, setFilter] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [manualAddress, setManualAddress] = useState('')
  const [manualTokenId, setManualTokenId] = useState('')
  const [manualType, setManualType] = useState(null) // auto-detected: 'ERC721', 'ERC1155', or null
  const [manualTypeLoading, setManualTypeLoading] = useState(false)
  const [manualTypeError, setManualTypeError] = useState(null)
  const [manualAmount, setManualAmount] = useState('1')
  const [quantityNft, setQuantityNft] = useState(null)
  const [quantity, setQuantity] = useState('1')

  // Auto-detect token type when manual address changes
  useEffect(() => {
    setManualType(null)
    setManualTypeError(null)
    if (!manualAddress.match(/^0x[0-9a-fA-F]{40}$/)) return
    const chain = CHAINS[chainId]
    if (!chain) return
    setManualTypeLoading(true)
    const provider = new JsonRpcProvider(chain.rpcUrl)
    const contract = new Contract(manualAddress, ERC165_ABI, provider)
    Promise.all([
      contract.supportsInterface('0xd9b67a26'), // ERC-1155
      contract.supportsInterface('0x80ac58cd'), // ERC-721
    ]).then(([is1155, is721]) => {
      if (is1155) setManualType('ERC1155')
      else if (is721) setManualType('ERC721')
      else setManualTypeError('Unrecognized contract')
      setManualTypeLoading(false)
    }).catch(() => {
      setManualTypeError('Unrecognized contract')
      setManualTypeLoading(false)
    })
  }, [manualAddress, chainId])

  const [openCollection, setOpenCollection] = useState(null)
  const [fullCollectionNfts, setFullCollectionNfts] = useState(null)
  const [collectionPageKeys, setCollectionPageKeys] = useState({}) // { contractAddr: pageKey }
  const [loadingCollection, setLoadingCollection] = useState(false)
  const [loadingMoreNfts, setLoadingMoreNfts] = useState(false)
  const [showSpam, setShowSpam] = useState(false)
  const [initialKeys, setInitialKeys] = useState(null)

  // Expose a "try back out" function: returns true if it handled the back (closed a collection)
  useEffect(() => {
    if (backRef) {
      backRef.current = () => {
        if (openCollection) {
          setOpenCollection(null)
          setFullCollectionNfts(null)
          setCollectionPageKeys({})
          return true
        }
        return false
      }
    }
  }, [backRef, openCollection])

  // Compute which collection to drill into (for the fetch effect + render)
  // Auto-expand: if there's exactly one non-spam collection and no spam, drill in automatically
  const autoExpandAddr = (() => {
    const entries = Object.entries(collections)
    const nonSpam = entries.filter(([, c]) => !c.isSpam)
    if (nonSpam.length === 1 && entries.length === nonSpam.length) return nonSpam[0][0]
    return null
  })()
  const effectiveDrillAddr = openCollection || autoExpandAddr || null

  // Get all contract addresses for a collection (canonical + aliases)
  const getDrillContracts = useCallback((addr) => {
    if (!addr) return []
    const col = collections[addr]
    const contracts = [addr]
    if (col?._aliases) {
      for (const alias of col._aliases) {
        if (!contracts.includes(alias)) contracts.push(alias)
      }
    }
    return contracts
  }, [collections])

  // When drilling into a collection, fetch first page from all contracts
  useEffect(() => {
    if (!effectiveDrillAddr || !address || !chainId) {
      setFullCollectionNfts(null)
      setCollectionPageKeys({})
      return
    }
    let cancelled = false
    setLoadingCollection(true)
    const contracts = getDrillContracts(effectiveDrillAddr)
    Promise.all(contracts.map((c) => fetchNFTsForContract(address, chainId, c)))
      .then((results) => {
        if (cancelled) return
        const allNfts = []
        const keys = {}
        for (let i = 0; i < contracts.length; i++) {
          allNfts.push(...results[i].nfts)
          if (results[i].pageKey) keys[contracts[i]] = results[i].pageKey
        }
        setFullCollectionNfts(allNfts)
        setCollectionPageKeys(keys)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingCollection(false) })
    return () => { cancelled = true }
  }, [effectiveDrillAddr, address, chainId, getDrillContracts])

  const hasMoreNfts = Object.keys(collectionPageKeys).length > 0

  const loadMoreNfts = useCallback(async () => {
    if (!hasMoreNfts || loadingMoreNfts) return
    setLoadingMoreNfts(true)
    try {
      const entries = Object.entries(collectionPageKeys)
      const results = await Promise.all(
        entries.map(([contract, pk]) => fetchNFTsForContract(address, chainId, contract, pk))
      )
      const newNfts = []
      const newKeys = {}
      for (let i = 0; i < entries.length; i++) {
        newNfts.push(...results[i].nfts)
        if (results[i].pageKey) newKeys[entries[i][0]] = results[i].pageKey
      }
      setFullCollectionNfts((prev) => [...(prev || []), ...newNfts])
      setCollectionPageKeys(newKeys)
    } catch { /* ignore */ }
    finally { setLoadingMoreNfts(false) }
  }, [collectionPageKeys, hasMoreNfts, loadingMoreNfts, address, chainId])

  // Fetch collections via getContractsForOwner
  useEffect(() => {
    if (!address || !chainId || !isOwnWallet) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setCollections({})
    setPageKey(null)
    setOpenCollection(null)
    setInitialKeys(null)
    setPaginationBroken(false)

    async function fetchUntilFull() {
      let allCols = {}
      let key = null

      try {
        const first = await fetchCollections(address, chainId)
        if (cancelled) return
        for (const col of first.collections) {
          allCols[col.address.toLowerCase()] = normalizeCollection(col, chainId)
        }
        key = first.pageKey

        // Auto-fetch until 250 non-spam collections
        while (key && !cancelled) {
          const nonSpamCount = Object.values(allCols).filter((c) => !c.isSpam).length
          if (nonSpamCount >= 250) break

          const prevKey = key
          const page = await fetchCollections(address, chainId, key)
          if (cancelled) return

          // Alchemy pagination bug: page 2+ often returns 400 → empty result.
          // Preserve the last valid pageKey so we know there are more collections.
          if (page.collections.length === 0) {
            key = prevKey
            setPaginationBroken(true)
            break
          }

          for (const col of page.collections) {
            allCols[col.address.toLowerCase()] = normalizeCollection(col, chainId)
          }
          key = page.pageKey
        }

        // Merge aliased collections and sort before first render
        if (!cancelled) {
          applyCollectionMerges(allCols, chainId)
          const sorted = sortCollectionEntries(Object.entries(allCols))
          setInitialKeys(sorted.map(([k]) => k))
          setCollections({ ...allCols })
          setPageKey(key)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchUntilFull()
    return () => { cancelled = true }
  }, [address, chainId, isOwnWallet])

  const loadMore = useCallback(async () => {
    if (!pageKey || loadingMore || paginationBroken) return
    setLoadingMore(true)
    try {
      let key = pageKey
      const normalized = {}
      let nonSpamCount = 0

      while (key && nonSpamCount < 250) {
        const prevKey = key
        const { collections: more, pageKey: nextKey } = await fetchCollections(address, chainId, key)
        if (more.length === 0) {
          key = prevKey
          setPaginationBroken(true)
          break
        }
        for (const col of more) {
          const norm = normalizeCollection(col, chainId)
          normalized[col.address.toLowerCase()] = norm
          if (!norm.isSpam) nonSpamCount++
        }
        key = nextKey
        if (!key) break
      }

      if (Object.keys(normalized).length > 0) {
        applyCollectionMerges(normalized, chainId)
        // Also merge into existing collections (alias in new batch, canonical in old)
        setCollections((prev) => {
          const merged = { ...prev }
          const { aliasToCanonical } = buildMergedLookups(chainId)
          for (const [addr, col] of Object.entries(normalized)) {
            const canonical = aliasToCanonical[addr]
            if (canonical && merged[canonical]) {
              merged[canonical] = {
                ...merged[canonical],
                tokenCount: String((Number(merged[canonical].tokenCount) || 0) + (Number(col.tokenCount) || 0)),
                totalBalance: String((Number(merged[canonical].totalBalance) || 0) + (Number(col.totalBalance) || 0)),
              }
            } else {
              merged[addr] = col
            }
          }
          return merged
        })
        // Only add keys for entries that weren't merged into existing canonical
        const { aliasToCanonical } = buildMergedLookups(chainId)
        const newKeys = Object.keys(normalized).filter((k) => !aliasToCanonical[k])
        if (newKeys.length > 0) {
          const newEntries = newKeys.map((k) => [k, normalized[k]])
          sortCollectionEntries(newEntries)
          setInitialKeys((prev) => prev ? [...prev, ...newEntries.map(([k]) => k)] : null)
        }
      }
      setPageKey(key)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }, [address, chainId, pageKey, loadingMore, paginationBroken])

  const isSelected = useCallback((contract, tokenId) => {
    return selected.some((a) =>
      a.token?.toLowerCase() === contract.toLowerCase() && String(a.tokenId) === String(tokenId)
    )
  }, [selected])

  const resolveCollectionName = useCallback((contract, fallback) => {
    const addr = contract.toLowerCase()
    const { aliasToCanonical, canonicalMeta } = buildMergedLookups(chainId)
    const canonical = aliasToCanonical[addr] || addr
    const meta = canonicalMeta[canonical]
    if (meta?.name) return meta.name
    // Check the loaded collections state
    const col = collections[canonical] || collections[addr]
    if (col?.name) return col.name
    return fallback
  }, [chainId, collections])

  const toggleNft = useCallback((nft) => {
    const contract = nft.contract
    const tokenId = nft.tokenId

    if (isSelected(contract, tokenId)) {
      onChange(selected.filter((a) =>
        !(a.token?.toLowerCase() === contract.toLowerCase() && String(a.tokenId) === String(tokenId))
      ))
      return
    }

    if (nft.tokenType === 'ERC1155' && BigInt(nft.balance) > 1n) {
      setQuantityNft(nft)
      setQuantity('1')
      return
    }

    onChange([...selected, {
      token: contract,
      tokenId,
      amount: '1',
      assetType: nft.tokenType === 'ERC1155' ? 'ERC1155' : 'ERC721',
      _name: nft.name,
      _image: nft.image,
      _collection: resolveCollectionName(contract, nft.contractName),
    }])
  }, [selected, onChange, isSelected, resolveCollectionName])

  const confirmQuantity = useCallback(() => {
    if (!quantityNft) return
    const qty = parseInt(quantity, 10)
    if (!qty || qty < 1 || qty > Number(quantityNft.balance)) return
    onChange([...selected, {
      token: quantityNft.contract,
      tokenId: quantityNft.tokenId,
      amount: String(qty),
      assetType: 'ERC1155',
      _name: quantityNft.name,
      _image: quantityNft.image,
      _collection: resolveCollectionName(quantityNft.contract, quantityNft.contractName),
    }])
    setQuantityNft(null)
  }, [quantityNft, quantity, selected, onChange, resolveCollectionName])

  const addManual = useCallback(async () => {
    if (!manualAddress.match(/^0x[0-9a-fA-F]{40}$/) || (!manualTokenId && manualTokenId !== '0') || !manualType) return
    const asset = {
      token: manualAddress,
      tokenId: manualTokenId,
      amount: manualType === 'ERC1155' ? manualAmount || '1' : '1',
      assetType: manualType,
    }
    try {
      const meta = await fetchMetadata(chainId, manualAddress, manualTokenId, manualType === 'ERC1155' ? 1 : 0)
      if (meta) {
        asset._name = meta.name
        asset._image = meta.image
      }
    } catch { /* ignore */ }
    onChange([...selected, asset])
    setManualAddress('')
    setManualTokenId('')
    setManualAmount('1')
    setShowManual(false)
  }, [manualAddress, manualTokenId, manualType, manualAmount, chainId, selected, onChange])

  // Filter collections
  const filterLower = filter.toLowerCase()
  const filteredCollections = filter
    ? Object.fromEntries(
        Object.entries(collections).filter(([addr, col]) =>
          col.name.toLowerCase().includes(filterLower) ||
          addr.includes(filterLower)
        )
      )
    : collections

  // Order collections: initial load sorted (verified first), then new additions at end
  const orderedEntries = (() => {
    const entries = Object.entries(filteredCollections)
    if (!initialKeys || filter) return entries
    const entryMap = Object.fromEntries(entries)
    const ordered = []
    // Initial keys in their sorted order
    for (const k of initialKeys) {
      if (entryMap[k]) ordered.push([k, entryMap[k]])
    }
    // New keys (shouldn't normally exist since loadMore adds to initialKeys)
    for (const [k, v] of entries) {
      if (!initialKeys.includes(k)) ordered.push([k, v])
    }
    return ordered
  })()

  // Split into non-spam and spam
  const collectionEntries = orderedEntries.filter(([, col]) => !col.isSpam)
  const spamEntries = orderedEntries.filter(([, col]) => col.isSpam)

  // Use the pre-computed drill address (handles both explicit open and auto-expand)
  // When filtering, suppress auto-expand but allow explicit drill-in
  const drillAddr = (filter && !openCollection) ? null : effectiveDrillAddr
  const drillCollectionMeta = drillAddr ? collections[drillAddr] : null
  // Collections from getContractsForOwner don't include individual NFTs —
  // drill-down always uses fullCollectionNfts from fetchNFTsForContract
  const drillCollection = drillCollectionMeta
    ? { ...drillCollectionMeta, nfts: fullCollectionNfts || [] }
    : null

  return (
    <div className="collectibles-tab">
      {quantityNft && (
        <div className="quantity-picker">
          <p>
            How many <strong>{quantityNft.name}</strong>? (max {quantityNft.balance})
          </p>
          <div className="quantity-picker-row">
            <input
              type="number"
              min="1"
              max={quantityNft.balance}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <button type="button" className="btn btn-sm" onClick={confirmQuantity}>Add</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQuantityNft(null)}>Cancel</button>
          </div>
        </div>
      )}

      {isOwnWallet && Object.keys(collections).length > 0 && (
        <input
          type="text"
          className="asset-picker-filter"
          placeholder="Search by name or collection..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      {loading && <div className="spinner-center"><span className="spinner" /></div>}

      {error && <p className="form-error">{error}</p>}

      {isOwnWallet && !loading && !error && Object.keys(collections).length === 0 && (
        <p className="text-muted">No collectibles found. You can add one manually below.</p>
      )}

      {!isOwnWallet && (
        <p className="text-muted">Add collectibles by contract address and token ID.</p>
      )}

      {/* Drill-down: show individual tokens from a collection */}
      {drillCollection && (
        <div className="collection-drill">
          {!autoExpandAddr && (
            <button
              type="button"
              className="btn-link collection-back"
              onClick={() => { setOpenCollection(null); setFullCollectionNfts(null); setCollectionPageKeys({}) }}
            >
              &larr; All collections
            </button>
          )}
          <h4 className="collection-drill-title">{drillCollection.name}</h4>
          {loadingCollection && <div className="spinner-center"><span className="spinner" /></div>}
          <div className="nft-grid">
            {drillCollection.nfts.map((nft) => {
              const sel = isSelected(nft.contract, nft.tokenId)
              return (
                <button
                  key={`${nft.contract}-${nft.tokenId}`}
                  className={`nft-grid-item${sel ? ' nft-grid-item-selected' : ''}`}
                  onClick={() => toggleNft(nft)}
                  type="button"
                >
                  <div className="nft-grid-image">
                    {nft.image ? (
                      <img src={nft.image} alt={nft.name} loading="lazy" />
                    ) : (
                      <span className="asset-card-placeholder">?</span>
                    )}
                    {sel && <span className="nft-grid-check">&#10003;</span>}
                    <a
                      href={`https://opensea.io/assets/${OPENSEA_CHAINS[chainId] || 'ethereum'}/${nft.contract}/${nft.tokenId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="nft-grid-opensea"
                      title="View on OpenSea"
                      onClick={(e) => e.stopPropagation()}
                    ><img src={openseaLogo} alt="OpenSea" /></a>
                  </div>
                  <div className="nft-grid-label">
                    <span className="nft-grid-name">{nft.name}</span>
                  </div>
                </button>
              )
            })}
          </div>
          {hasMoreNfts && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={loadMoreNfts}
              disabled={loadingMoreNfts}
              style={{ display: 'block', marginTop: '0.5rem' }}
            >
              {loadingMoreNfts ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Loading...</> : 'Load More'}
            </button>
          )}
        </div>
      )}

      {/* Collection grid: show grouped collections */}
      {!drillCollection && collectionEntries.length > 0 && (
        <div className="nft-grid">
          {collectionEntries.map(([contractAddr, col]) => {
            const selectedCount = selected.filter((a) =>
              a.token?.toLowerCase() === contractAddr.toLowerCase()
            ).length
            return (
              <button
                key={contractAddr}
                className={`nft-grid-item${selectedCount > 0 ? ' nft-grid-item-selected' : ''}${col.isSpam ? ' nft-grid-item-spam' : ''}`}
                onClick={() => setOpenCollection(contractAddr)}
                type="button"
              >
                <div className="nft-grid-image">
                  {col.thumbnail ? (
                    <img src={col.thumbnail} alt={col.name} loading="lazy" />
                  ) : (
                    <span className="asset-card-placeholder">?</span>
                  )}
                  {selectedCount > 0 && <span className="nft-grid-check">{selectedCount}</span>}
                  {col.isVerified && <span className="nft-grid-verified" title="Verified on OpenSea">&#10003;</span>}
                </div>
                <div className="nft-grid-label">
                  <span className="nft-grid-name">{col.name}</span>
                  {Number(col.tokenCount) > 0 && (
                    <span className="nft-grid-count">{col.tokenCount} owned</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {pageKey && !loading && !drillCollection && (
        paginationBroken ? (
          <p className="text-muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
            Some collections may not be shown. Use &ldquo;Add collectible manually&rdquo; below if you don&rsquo;t see what you&rsquo;re looking for.
          </p>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={loadMore}
            disabled={loadingMore}
            style={{ display: 'block', marginTop: '0.5rem' }}
          >
            {loadingMore ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Loading...</> : 'Load More Collections'}
          </button>
        )
      )}

      {spamEntries.length > 0 && !drillCollection && (
        <>
          <button
            type="button"
            className="btn-link btn-sm"
            onClick={() => setShowSpam(!showSpam)}
            style={{ display: 'block', marginTop: '0.5rem' }}
          >
            {showSpam ? 'Hide' : 'Show'} Potential Spam ({spamEntries.length})
          </button>

          {showSpam && (
            <div className="nft-grid">
              {spamEntries.map(([contractAddr, col]) => {
                const selectedCount = selected.filter((a) =>
                  a.token?.toLowerCase() === contractAddr.toLowerCase()
                ).length
                return (
                  <button
                    key={contractAddr}
                    className={`nft-grid-item nft-grid-item-spam${selectedCount > 0 ? ' nft-grid-item-selected' : ''}`}
                    onClick={() => setOpenCollection(contractAddr)}
                    type="button"
                  >
                    <div className="nft-grid-image">
                      {col.thumbnail ? (
                        <img src={col.thumbnail} alt={col.name} loading="lazy" />
                      ) : (
                        <span className="asset-card-placeholder">?</span>
                      )}
                      {selectedCount > 0 && <span className="nft-grid-check">{selectedCount}</span>}
                    </div>
                    <div className="nft-grid-label">
                      <span className="nft-grid-name">{col.name}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      <div className="manual-entry">
        <button
          type="button"
          className="btn-link"
          onClick={() => setShowManual(!showManual)}
        >
          {showManual ? 'Hide manual entry' : 'Add collectible manually'}
        </button>

        {showManual && (
          <div className="manual-entry-form">
            {address && (
              <a
                href={`https://opensea.io/${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-link btn-sm"
                style={{ marginBottom: '0.5rem', display: 'inline-block' }}
              >
                View on OpenSea &rarr;
              </a>
            )}
            <input
              type="text"
              placeholder="Contract address (0x...)"
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              spellCheck={false}
            />
            <input
              type="text"
              placeholder="Token ID"
              value={manualTokenId}
              onChange={(e) => setManualTokenId(e.target.value)}
            />
            <div className="manual-entry-row">
              {manualType === 'ERC1155' && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  Amount:
                  <input
                    type="number"
                    min="1"
                    value={manualAmount}
                    onChange={(e) => setManualAmount(e.target.value)}
                    style={{ width: '60px' }}
                  />
                </label>
              )}
              <button
                type="button"
                className="btn btn-sm"
                onClick={addManual}
                disabled={!manualType || !manualAddress.match(/^0x[0-9a-fA-F]{40}$/) || (!manualTokenId && manualTokenId !== '0')}
              >
                Add
              </button>
              {manualType && <span className="text-muted">{manualType === 'ERC1155' ? 'ERC-1155' : 'ERC-721'}</span>}
            </div>
            <p className="form-error" style={{ visibility: manualTypeError ? 'visible' : 'hidden', margin: 0 }}>{manualTypeError || '\u00A0'}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Cash Tab ──────────────────────────────────────────────────────

function CashTab({ address, chainId, selected, onChange, showNative, isOwnWallet, dimZeroBalance }) {
  const [balances, setBalances] = useState({})
  const [loadingBal, setLoadingBal] = useState(false)
  const [nativeBalance, setNativeBalance] = useState(null)

  const whitelisted = WHITELISTED_ERC20[chainId] || {}
  const tokens = Object.entries(whitelisted)

  // Fetch balances
  useEffect(() => {
    if (!address || !chainId || !isOwnWallet) return
    const chain = CHAINS[chainId]
    if (!chain) return

    setLoadingBal(true)
    const provider = new JsonRpcProvider(chain.rpcUrl)

    const promises = tokens.map(async ([addr, info]) => {
      try {
        const contract = new Contract(addr, ERC20_ABI, provider)
        const bal = await contract.balanceOf(address)
        return [addr, formatUnits(bal, info.decimals)]
      } catch {
        return [addr, null]
      }
    })

    if (showNative) {
      promises.push(
        provider.getBalance(address).then((bal) => {
          setNativeBalance(formatUnits(bal, 18))
          return null
        }).catch(() => null)
      )
    }

    Promise.all(promises).then((results) => {
      const map = {}
      for (const r of results) {
        if (r && r[0]) map[r[0]] = r[1]
      }
      setBalances(map)
      setLoadingBal(false)
    })
  }, [address, chainId, isOwnWallet])

  const getSelectedAmount = useCallback((tokenAddr) => {
    const asset = selected.find((a) =>
      a.assetType === 'ERC20' && a.token?.toLowerCase() === tokenAddr.toLowerCase()
    )
    return asset?.amount || ''
  }, [selected])

  const getNativeAmount = useCallback(() => {
    const asset = selected.find((a) => a.assetType === 'NATIVE')
    return asset?.amount || ''
  }, [selected])

  const setTokenAmount = useCallback((tokenAddr, symbol, decimals, amount) => {
    const rest = selected.filter((a) =>
      !(a.assetType === 'ERC20' && a.token?.toLowerCase() === tokenAddr.toLowerCase())
    )
    if (amount !== '' && amount !== undefined) {
      rest.push({ token: tokenAddr, amount, assetType: 'ERC20', _symbol: symbol, _decimals: decimals })
    }
    onChange(rest)
  }, [selected, onChange])

  const setNativeAmount = useCallback((amount) => {
    const rest = selected.filter((a) => a.assetType !== 'NATIVE')
    if (amount !== '' && amount !== undefined) {
      rest.push({ assetType: 'NATIVE', token: '', tokenId: '', amount })
    }
    onChange(rest)
  }, [selected, onChange])

  return (
    <div className="cash-tab">
      {showNative && (
        <CashRow
          symbol={CHAINS[chainId]?.nativeSymbol || 'ETH'}
          balance={isOwnWallet ? nativeBalance : null}
          showBalance={isOwnWallet}
          amount={getNativeAmount()}
          onAmountChange={setNativeAmount}
          disabled={dimZeroBalance && isOwnWallet && (nativeBalance === null || Number(nativeBalance) === 0)}
        />
      )}

      {tokens.map(([addr, info]) => {
        const bal = balances[addr]
        const disabled = dimZeroBalance && isOwnWallet && (bal === undefined || bal === null || Number(bal) === 0)
        return (
          <CashRow
            key={addr}
            symbol={info.symbol}
            balance={isOwnWallet ? bal : null}
            showBalance={isOwnWallet}
            amount={getSelectedAmount(addr)}
            onAmountChange={(amt) => setTokenAmount(addr, info.symbol, info.decimals, amt)}
            disabled={disabled}
          />
        )
      })}
    </div>
  )
}

const TOKEN_LOGOS = {
  ETH: new URL('../../assets/tokens/eth.png', import.meta.url).href,
  POL: new URL('../../assets/tokens/pol.png', import.meta.url).href,
  WETH: new URL('../../assets/tokens/weth.png', import.meta.url).href,
  USDC: new URL('../../assets/tokens/usdc.png', import.meta.url).href,
  USDT: new URL('../../assets/tokens/usdt.png', import.meta.url).href,
  USDT0: new URL('../../assets/tokens/usdt.png', import.meta.url).href,
  USDS: new URL('../../assets/tokens/usds.png', import.meta.url).href,
  EURC: new URL('../../assets/tokens/eurc.png', import.meta.url).href,
}

function CashRow({ symbol, balance, showBalance, amount, onAmountChange, disabled }) {
  const logo = TOKEN_LOGOS[symbol]
  const exceeds = showBalance && balance !== null && balance !== undefined && amount && Number(amount) > Number(balance)
  return (
    <div className={`cash-row${disabled ? ' cash-row-disabled' : ''}`}>
      <div className="cash-row-info">
        {logo && <img src={logo} alt={symbol} className="cash-row-logo" />}
        <div className="cash-row-text">
          <span className="cash-row-symbol">{symbol}</span>
          {showBalance && (
            <span className="cash-row-balance">Balance: {balance !== null && balance !== undefined ? Number(balance).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '–'}</span>
          )}
        </div>
      </div>
      <div className="cash-row-input">
        <input
          type="text"
          placeholder="0"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          disabled={disabled}
        />
        {exceeds && <span className="cash-row-warning">Exceeds balance</span>}
      </div>
    </div>
  )
}
