export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

export const CHAINS = {
  1: { name: 'Ethereum', rpcUrl: 'https://ethereum-rpc.publicnode.com' },
  11155111: { name: 'Sepolia', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' },
}

// Seaport 1.6 canonical address (same on all chains)
export const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395'

// OTCZone contract addresses per chain
export const ZONE_ADDRESSES = {
  1: null,        // mainnet — not deployed yet
  11155111: null,  // sepolia — not deployed yet
}

// Block number at or before OTCZone deployment — used as fromBlock for event queries
export const ZONE_DEPLOY_BLOCKS = {
  1: 0,
  11155111: 0,
}

// Whitelisted ERC-20 tokens per chain
export const WHITELISTED_ERC20 = {
  1: {
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { symbol: 'WETH', decimals: 18 },
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { symbol: 'USDC', decimals: 6 },
    '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c': { symbol: 'EURC', decimals: 6 },
    '0xdC035D45d973E3EC169d2276DDab16f1e407384F': { symbol: 'USDS', decimals: 18 },
  },
  11155111: {
    // Sepolia test tokens — update with actual addresses when testing
  },
}

// OTCZone ABI — only the parts we call from the frontend
export const ZONE_ABI = [
  {
    type: 'function',
    name: 'registerOrder',
    inputs: [
      { name: 'orderHash', type: 'bytes32' },
      { name: 'taker', type: 'address' },
      {
        name: 'offer',
        type: 'tuple[]',
        components: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifier', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
        ],
      },
      {
        name: 'consideration',
        type: 'tuple[]',
        components: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifier', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'recipient', type: 'address' },
        ],
      },
      { name: 'orderURI', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'OrderRegistered',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'maker', type: 'address', indexed: true },
      { name: 'taker', type: 'address', indexed: true },
      { name: 'orderURI', type: 'string', indexed: false },
    ],
    anonymous: false,
  },
]
