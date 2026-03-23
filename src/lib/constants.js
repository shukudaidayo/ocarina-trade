export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

export const CHAINS = {
  1: { name: 'Ethereum', nativeSymbol: 'ETH', rpcUrl: 'https://ethereum-rpc.publicnode.com', blockscoutApi: 'https://eth.blockscout.com/api' },
  8453: { name: 'Base', nativeSymbol: 'ETH', rpcUrl: 'https://base-rpc.publicnode.com', blockscoutApi: 'https://base.blockscout.com/api' },
  137: { name: 'Polygon', nativeSymbol: 'POL', rpcUrl: 'https://polygon-bor-rpc.publicnode.com', blockscoutApi: 'https://polygon.blockscout.com/api' },
}

// Seaport 1.6 canonical address (same on all chains)
export const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395'

// OTCZone contract addresses per chain
export const ZONE_ADDRESSES = {
  1: '0x07C0000003f04E1b0b040A5B6c8AAB792d9546fc',
  8453: '0x07C00000090AdB1D14b093C1A6b40135779af27C',
  137: '0x07C000000b63fEe6aC08B91ad7aD3d999b28d740',
}

// Block number at or before OTCZone deployment — used as fromBlock for event queries
export const ZONE_DEPLOY_BLOCKS = {
  1: 24694574,
  8453: 43637380,
  137: 84472380,
}

// Whitelisted ERC-20 tokens per chain
export const WHITELISTED_ERC20 = {
  1: {
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { symbol: 'WETH', decimals: 18 },
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { symbol: 'USDC', decimals: 6 },
    '0xdAC17F958D2ee523a2206206994597C13D831ec7': { symbol: 'USDT', decimals: 6 },
    '0xdC035D45d973E3EC169d2276DDab16f1e407384F': { symbol: 'USDS', decimals: 18 },
    '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c': { symbol: 'EURC', decimals: 6 },
  },
  8453: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': { symbol: 'USDC', decimals: 6 },
    '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc': { symbol: 'USDS', decimals: 18 },
    '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42': { symbol: 'EURC', decimals: 6 },
  },
  137: {
    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': { symbol: 'WETH', decimals: 18 },
    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': { symbol: 'USDC', decimals: 6 },
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F': { symbol: 'USDT0', decimals: 6 },
  },
}

// OTCZone ABI — only the parts we call from the frontend
export const ZONE_ABI = [
  {
    type: 'function',
    name: 'registerOrder',
    inputs: [
      {
        name: 'reg',
        type: 'tuple',
        components: [
          { name: 'orderHash', type: 'bytes32' },
          { name: 'maker', type: 'address' },
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
          { name: 'signature', type: 'bytes' },
          { name: 'orderURI', type: 'string' },
          { name: 'memo', type: 'string' },
        ],
      },
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
      { name: 'memo', type: 'string', indexed: false },
    ],
    anonymous: false,
  },
]
