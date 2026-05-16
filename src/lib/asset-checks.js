import { Contract, JsonRpcProvider } from 'ethers'
import { CHAINS, SEAPORT_ADDRESS } from './constants'
import { ItemType } from '@opensea/seaport-js/lib/constants'

const ERC721_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]
const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]
const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

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
