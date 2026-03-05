import { AbiCoder, BrowserProvider, Contract, JsonRpcProvider, keccak256 } from 'ethers'
import { CONTRACT_ABI, CONTRACT_ADDRESSES, CHAINS } from './constants'

const ERC721_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]

const ERC1155_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]

/**
 * Get an ethers signer from a raw EIP-1193 provider.
 */
export async function getSigner(rawProvider) {
  const provider = new BrowserProvider(rawProvider)
  return provider.getSigner()
}

/**
 * Get the OTCSwap contract instance connected to a signer.
 */
export async function getSwapContract(rawProvider, chainId) {
  const address = CONTRACT_ADDRESSES[chainId]
  if (!address) throw new Error(`No contract deployed on chain ${chainId}`)
  const signer = await getSigner(rawProvider)
  return new Contract(address, CONTRACT_ABI, signer)
}

/**
 * Check if a token contract is approved for the swap contract, and request approval if not.
 * Works for both ERC-721 and ERC-1155 (both use isApprovedForAll/setApprovalForAll).
 */
export async function ensureApproval(rawProvider, chainId, tokenAddress, owner) {
  const swapAddress = CONTRACT_ADDRESSES[chainId]
  if (!swapAddress) throw new Error(`No contract deployed on chain ${chainId}`)

  const signer = await getSigner(rawProvider)
  const token = new Contract(tokenAddress, ERC721_ABI, signer)

  const approved = await token.isApprovedForAll(owner, swapAddress)
  if (approved) return null

  const tx = await token.setApprovalForAll(swapAddress, true)
  return tx
}

/**
 * Call createOrder on the swap contract. Returns the tx receipt and order hash.
 */
export async function createOrder(rawProvider, chainId, { taker, makerAssets, takerAssets, expiration, salt }) {
  const contract = await getSwapContract(rawProvider, chainId)

  const formattedMaker = makerAssets.map(formatAsset)
  const formattedTaker = takerAssets.map(formatAsset)

  const tx = await contract.createOrder(
    taker,
    formattedMaker,
    formattedTaker,
    expiration,
    salt,
  )

  const receipt = await tx.wait()

  // Extract orderHash from OrderCreated event
  const log = receipt.logs.find((l) => {
    try {
      return contract.interface.parseLog(l)?.name === 'OrderCreated'
    } catch {
      return false
    }
  })

  const orderHash = log ? contract.interface.parseLog(log).args.orderHash : null
  return { receipt, orderHash }
}

export const ORDER_STATUS = ['NONE', 'OPEN', 'FILLED', 'CANCELLED']

/**
 * Get the on-chain status of an order using a read-only provider.
 */
export async function getOrderStatus(chainId, contractAddress, orderHash) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const contract = new Contract(contractAddress, CONTRACT_ABI, provider)
  const status = await contract.orders(orderHash)
  return Number(status)
}

/**
 * Call fillOrder on the swap contract.
 */
export async function fillOrder(rawProvider, chainId, { maker, taker, makerAssets, takerAssets, expiration, salt }) {
  const contract = await getSwapContract(rawProvider, chainId)
  const tx = await contract.fillOrder(
    maker,
    taker,
    makerAssets.map(formatAsset),
    takerAssets.map(formatAsset),
    expiration,
    salt,
  )
  return tx.wait()
}

/**
 * Call cancelOrder on the swap contract.
 */
export async function cancelOrder(rawProvider, chainId, orderHash) {
  const contract = await getSwapContract(rawProvider, chainId)
  const tx = await contract.cancelOrder(orderHash)
  return tx.wait()
}

/**
 * Compute the order hash locally (matches the contract's keccak256 encoding).
 */
export function computeOrderHash(maker, taker, makerAssets, takerAssets, expiration, salt) {
  const coder = AbiCoder.defaultAbiCoder()
  const encoded = coder.encode(
    ['address', 'address', 'tuple(address,uint256,uint256,uint8)[]', 'tuple(address,uint256,uint256,uint8)[]', 'uint256', 'uint256'],
    [maker, taker, makerAssets.map(formatAsset), takerAssets.map(formatAsset), expiration, salt],
  )
  return keccak256(encoded)
}

/**
 * Query all OrderCreated, OrderFilled, and OrderCancelled events.
 * Returns { created, filled, cancelled } where each is an array of parsed events.
 */
export async function queryOrderEvents(chainId, contractAddress) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const contract = new Contract(contractAddress, CONTRACT_ABI, provider)

  const [createdLogs, filledLogs, cancelledLogs] = await Promise.all([
    contract.queryFilter('OrderCreated'),
    contract.queryFilter('OrderFilled'),
    contract.queryFilter('OrderCancelled'),
  ])

  const created = createdLogs.map((log) => ({
    orderHash: log.args.orderHash,
    maker: log.args.maker,
    taker: log.args.taker,
    makerAssets: log.args.makerAssets.map(parseAssetFromEvent),
    takerAssets: log.args.takerAssets.map(parseAssetFromEvent),
    expiration: Number(log.args.expiration),
    salt: Number(log.args.salt),
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  }))

  const filledHashes = new Set(filledLogs.map((l) => l.args.orderHash))
  const cancelledHashes = new Set(cancelledLogs.map((l) => l.args.orderHash))

  return { created, filledHashes, cancelledHashes }
}

function parseAssetFromEvent(asset) {
  return {
    token: asset.token,
    tokenId: asset.tokenId.toString(),
    amount: asset.amount.toString(),
    assetType: Number(asset.assetType),
  }
}

function formatAsset(asset) {
  return {
    token: asset.token,
    tokenId: BigInt(asset.tokenId),
    amount: BigInt(asset.amount),
    assetType: asset.assetType,
  }
}
