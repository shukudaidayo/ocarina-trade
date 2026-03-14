import { Contract, JsonRpcProvider } from 'ethers'
import { CHAINS } from './constants'
import { ItemType } from '@opensea/seaport-js/lib/constants'

const ERC721_ABI = ['function ownerOf(uint256 tokenId) view returns (address)']
const ERC1155_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)']
const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)']

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
