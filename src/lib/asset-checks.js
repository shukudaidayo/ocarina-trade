import { Contract, JsonRpcProvider } from 'ethers'
import { CHAINS, SEAPORT_ADDRESS, SEAPORT_BLOCKED_NFTS } from './constants'
import { ItemType } from '@opensea/seaport-js/lib/constants'

const ERC721_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function transferFrom(address from, address to, uint256 tokenId)',
]
const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
]
const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const OPEN_OFFER_TRANSFER_TEST_RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const NFT_ITEM_TYPES = new Set([
  ItemType.ERC721,
  ItemType.ERC721_WITH_CRITERIA,
  ItemType.ERC1155,
  ItemType.ERC1155_WITH_CRITERIA,
])

function itemAmount(asset, fallback = '0') {
  return BigInt(asset.startAmount ?? asset.amount ?? fallback)
}

function itemIdentifier(asset) {
  return String(asset.identifierOrCriteria ?? asset.tokenId ?? '0')
}

function transferTestRecipients(owner, recipient) {
  const normalizedRecipient = recipient?.toLowerCase()
  const candidates = normalizedRecipient && normalizedRecipient !== ZERO_ADDRESS
    ? [recipient]
    : [owner, OPEN_OFFER_TRANSFER_TEST_RECIPIENT]

  return [...new Set(candidates.filter(Boolean).map((address) => address.toLowerCase()))]
}

function knownSeaportBlockedCollection(chainId, tokenAddress) {
  if (!tokenAddress) return null
  const blocked = SEAPORT_BLOCKED_NFTS[chainId] || {}
  const normalized = tokenAddress.toLowerCase()
  const match = Object.entries(blocked).find(([address]) => address.toLowerCase() === normalized)
  return match?.[1] || null
}

/**
 * Check a static list of collections known not to settle through canonical Seaport.
 * This is a gas-saving preflight before approval prompts, not the source of truth.
 */
export function checkKnownSeaportBlockedCollections(chainId, assets) {
  return assets.map((asset) => {
    if (!NFT_ITEM_TYPES.has(Number(asset.itemType))) return { allowed: true }

    const blocked = knownSeaportBlockedCollection(chainId, asset.token)
    if (!blocked) return { allowed: true }

    const name = blocked.name || 'This collection'
    const reason = blocked.reason || 'it cannot be transferred by Seaport'
    return {
      allowed: false,
      reason: `${name} cannot currently be traded because ${reason}`,
    }
  })
}

/**
 * Check whether an address holds all the given assets.
 * Returns an array of { held: bool, reason?: string } parallel to the input assets.
 */
export async function checkHoldings(chainId, address, assets) {
  const chain = CHAINS[chainId]
  if (!chain) return assets.map(() => ({ held: true }))
  const provider = new JsonRpcProvider(chain.rpcUrl)

  return Promise.all(assets.map(async (asset) => {
    const itemType = Number(asset.itemType)
    try {
      if (itemType === ItemType.NATIVE) {
        const balance = await provider.getBalance(address)
        const needed = BigInt(asset.startAmount || asset.amount || '0')
        if (balance < needed) return { held: false, reason: 'Insufficient ETH balance' }
        return { held: true }
      }

      if (itemType === ItemType.ERC20) {
        const token = new Contract(asset.token, ERC20_ABI, provider)
        const balance = await token.balanceOf(address)
        const needed = BigInt(asset.startAmount || asset.amount || '0')
        if (balance < needed) return { held: false, reason: 'Insufficient token balance' }
        return { held: true }
      }

      if (itemType === ItemType.ERC1155) {
        const token = new Contract(asset.token, ERC1155_ABI, provider)
        const balance = await token.balanceOf(address, asset.identifierOrCriteria || asset.tokenId)
        const needed = BigInt(asset.startAmount || asset.amount || '1')
        if (balance < needed) return { held: false, reason: 'Not held' }
        return { held: true }
      }

      // ERC-721
      const token = new Contract(asset.token, ERC721_ABI, provider)
      const owner = await token.ownerOf(asset.identifierOrCriteria || asset.tokenId)
      if (owner.toLowerCase() !== address.toLowerCase()) return { held: false, reason: 'Not held' }
      return { held: true }
    } catch {
      return { held: false, reason: 'Unable to verify' }
    }
  }))
}

/**
 * Check maker holdings for the /offers browse page.
 * Criteria-based items are treated conservatively: exact failures become missing,
 * wildcard ERC-721 criteria can be checked by collection balance, and anything
 * that cannot be verified generically is left unknown instead of hidden.
 */
export async function checkMakerOfferAvailability(chainId, address, assets) {
  const chain = CHAINS[chainId]
  if (!chain) return { status: 'unknown', reason: 'Unsupported chain' }
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const erc721CriteriaNeeds = new Map()
  let hasUnknown = false

  for (const asset of assets) {
    const itemType = Number(asset.itemType)

    if (itemType === ItemType.ERC721_WITH_CRITERIA) {
      if (itemIdentifier(asset) === '0' && asset.token) {
        const token = asset.token.toLowerCase()
        erc721CriteriaNeeds.set(token, (erc721CriteriaNeeds.get(token) || 0n) + itemAmount(asset, '1'))
      } else {
        hasUnknown = true
      }
      continue
    }

    if (itemType === ItemType.ERC1155_WITH_CRITERIA) {
      hasUnknown = true
      continue
    }

    try {
      if (itemType === ItemType.NATIVE) {
        const balance = await provider.getBalance(address)
        if (balance < itemAmount(asset)) {
          return { status: 'missing', reason: 'Insufficient ETH balance' }
        }
        continue
      }

      if (itemType === ItemType.ERC20) {
        const token = new Contract(asset.token, ERC20_ABI, provider)
        const balance = await token.balanceOf(address)
        if (balance < itemAmount(asset)) {
          return { status: 'missing', reason: 'Insufficient token balance' }
        }
        continue
      }

      if (itemType === ItemType.ERC721) {
        const token = new Contract(asset.token, ERC721_ABI, provider)
        const owner = await token.ownerOf(itemIdentifier(asset))
        if (owner.toLowerCase() !== address.toLowerCase()) {
          return { status: 'missing', reason: 'NFT no longer held' }
        }
        continue
      }

      if (itemType === ItemType.ERC1155) {
        const token = new Contract(asset.token, ERC1155_ABI, provider)
        const balance = await token.balanceOf(address, itemIdentifier(asset))
        if (balance < itemAmount(asset, '1')) {
          return { status: 'missing', reason: 'Token no longer held' }
        }
        continue
      }

      hasUnknown = true
    } catch {
      hasUnknown = true
    }
  }

  for (const [tokenAddress, needed] of erc721CriteriaNeeds.entries()) {
    try {
      const token = new Contract(tokenAddress, ERC721_ABI, provider)
      const balance = await token.balanceOf(address)
      if (balance < needed) {
        return { status: 'missing', reason: 'Insufficient collection balance' }
      }
    } catch {
      hasUnknown = true
    }
  }

  if (hasUnknown) return { status: 'unknown', reason: 'Unable to fully verify maker holdings' }
  return { status: 'available' }
}

/**
 * Check whether Seaport can pull the given assets from an address.
 * Returns an array of { approved: bool, reason?: string } parallel to the input assets.
 */
export async function checkSeaportApprovals(chainId, address, assets) {
  const chain = CHAINS[chainId]
  if (!chain) return assets.map(() => ({ approved: false, reason: 'Unsupported chain' }))
  const provider = new JsonRpcProvider(chain.rpcUrl)

  const erc20Needs = new Map()
  for (const asset of assets) {
    if (Number(asset.itemType) !== ItemType.ERC20) continue
    const token = asset.token.toLowerCase()
    const needed = BigInt(asset.startAmount || asset.amount || '0')
    erc20Needs.set(token, (erc20Needs.get(token) || 0n) + needed)
  }

  const erc20Approvals = new Map()
  await Promise.all([...erc20Needs.entries()].map(async ([token, needed]) => {
    try {
      const contract = new Contract(token, ERC20_ABI, provider)
      const allowance = await contract.allowance(address, SEAPORT_ADDRESS)
      erc20Approvals.set(token, allowance >= needed)
    } catch {
      erc20Approvals.set(token, false)
    }
  }))

  return Promise.all(assets.map(async (asset) => {
    const itemType = Number(asset.itemType)
    try {
      if (itemType === ItemType.NATIVE) return { approved: true }

      if (itemType === ItemType.ERC20) {
        const approved = erc20Approvals.get(asset.token.toLowerCase()) === true
        return approved ? { approved: true } : { approved: false, reason: 'Seaport allowance missing' }
      }

      if (itemType === ItemType.ERC721) {
        const token = new Contract(asset.token, ERC721_ABI, provider)
        const tokenId = asset.identifierOrCriteria || asset.tokenId
        const [operatorApproved, tokenApproved] = await Promise.all([
          token.isApprovedForAll(address, SEAPORT_ADDRESS),
          token.getApproved(tokenId).catch(() => null),
        ])
        if (operatorApproved || String(tokenApproved).toLowerCase() === SEAPORT_ADDRESS.toLowerCase()) {
          return { approved: true }
        }
        return { approved: false, reason: 'Seaport approval missing' }
      }

      if (itemType === ItemType.ERC721_WITH_CRITERIA || itemType === ItemType.ERC1155 || itemType === ItemType.ERC1155_WITH_CRITERIA) {
        const token = new Contract(asset.token, ERC1155_ABI, provider)
        const approved = await token.isApprovedForAll(address, SEAPORT_ADDRESS)
        return approved ? { approved: true } : { approved: false, reason: 'Seaport approval missing' }
      }

      return { approved: false, reason: 'Unsupported item type' }
    } catch {
      return { approved: false, reason: 'Unable to verify approval' }
    }
  }))
}

/**
 * Check whether Seaport can move exact maker-offered NFTs after approvals.
 * Criteria items are skipped because the concrete token ID is chosen at fill time.
 */
export async function checkSeaportTransferability(chainId, address, assets, recipient = null) {
  const chain = CHAINS[chainId]
  if (!chain) return assets.map(() => ({ transferable: false, reason: 'Unsupported chain' }))
  const provider = new JsonRpcProvider(chain.rpcUrl)

  const recipients = transferTestRecipients(address, recipient)

  return Promise.all(assets.map(async (asset) => {
    const itemType = Number(asset.itemType)
    if (itemType !== ItemType.ERC721 && itemType !== ItemType.ERC1155) {
      return { transferable: true }
    }

    let lastError = null
    try {
      const token = new Contract(asset.token, itemType === ItemType.ERC721 ? ERC721_ABI : ERC1155_ABI, provider)
      const identifier = itemIdentifier(asset)

      for (const to of recipients) {
        try {
          if (itemType === ItemType.ERC721) {
            await token.transferFrom.staticCall(address, to, identifier, { from: SEAPORT_ADDRESS })
          } else {
            await token.safeTransferFrom.staticCall(address, to, identifier, itemAmount(asset, '1'), '0x', { from: SEAPORT_ADDRESS })
          }
          return { transferable: true }
        } catch (err) {
          lastError = err
        }
      }
    } catch (err) {
      lastError = err
    }

    return {
      transferable: false,
      reason: lastError
        ? 'Collection transfer rules block Seaport from moving this NFT'
        : 'Unable to verify NFT transferability',
    }
  }))
}
