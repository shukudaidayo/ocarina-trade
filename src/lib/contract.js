import { BrowserProvider, Contract, Interface, JsonRpcProvider } from 'ethers'
import { CONTRACT_ABI, CONTRACT_ADDRESSES, CONTRACT_DEPLOY_BLOCKS, CHAINS } from './constants'

const APPROVAL_ABI = [
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
 * Ensure a token contract is approved for the swap contract via setApprovalForAll.
 * Works for both ERC-721 and ERC-1155.
 */
export async function ensureApproval(rawProvider, chainId, tokenAddress, owner) {
  const swapAddress = CONTRACT_ADDRESSES[chainId]
  if (!swapAddress) throw new Error(`No contract deployed on chain ${chainId}`)

  const signer = await getSigner(rawProvider)
  const token = new Contract(tokenAddress, APPROVAL_ABI, signer)

  const approved = await token.isApprovedForAll(owner, swapAddress)
  if (approved) return null

  const tx = await token.setApprovalForAll(swapAddress, true)
  return tx
}

/**
 * Send createOrder tx. Returns { tx, wait } where wait() resolves to { receipt, orderHash }.
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

  return {
    tx,
    wait: async () => {
      const receipt = await tx.wait()
      const log = receipt.logs.find((l) => {
        try {
          return contract.interface.parseLog(l)?.name === 'OrderCreated'
        } catch {
          return false
        }
      })
      const orderHash = log ? contract.interface.parseLog(log).args.orderHash : null
      return { receipt, orderHash }
    },
  }
}

export const ORDER_STATUS = ['NONE', 'OPEN', 'FILLED', 'CANCELLED']

/**
 * Fetch order data from a createOrder transaction hash.
 * Returns the parsed OrderCreated event data.
 */
export async function getOrderFromTx(chainId, txHash) {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const provider = new JsonRpcProvider(chain.rpcUrl)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) throw new Error('Transaction not found')

  const iface = new Interface(CONTRACT_ABI)
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log)
      if (parsed?.name === 'OrderCreated') {
        return {
          contractAddress: receipt.to,
          orderHash: parsed.args.orderHash,
          maker: parsed.args.maker,
          taker: parsed.args.taker,
          makerAssets: parsed.args.makerAssets.map(parseAssetFromEvent),
          takerAssets: parsed.args.takerAssets.map(parseAssetFromEvent),
          expiration: Number(parsed.args.expiration),
          salt: Number(parsed.args.salt),
        }
      }
    } catch {}
  }
  throw new Error('No OrderCreated event found in transaction')
}

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
 * Send fillOrder tx. Returns { tx, wait }.
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
  return { tx, wait: () => tx.wait() }
}

/**
 * Send cancelOrder tx. Returns { tx, wait }.
 */
export async function cancelOrder(rawProvider, chainId, orderHash) {
  const contract = await getSwapContract(rawProvider, chainId)
  const tx = await contract.cancelOrder(orderHash)
  return { tx, wait: () => tx.wait() }
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

  const fromBlock = CONTRACT_DEPLOY_BLOCKS[chainId] ?? 0
  const latestBlock = await provider.getBlockNumber()

  async function queryInChunks(eventName) {
    const chunkSize = 49999
    const logs = []
    for (let start = fromBlock; start <= latestBlock; start += chunkSize + 1) {
      const end = Math.min(start + chunkSize, latestBlock)
      const chunk = await contract.queryFilter(eventName, start, end)
      logs.push(...chunk)
    }
    return logs
  }

  const [createdLogs, filledLogs, cancelledLogs] = await Promise.all([
    queryInChunks('OrderCreated'),
    queryInChunks('OrderFilled'),
    queryInChunks('OrderCancelled'),
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
