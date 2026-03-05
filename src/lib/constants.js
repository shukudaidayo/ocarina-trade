export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

export const CHAINS = {
  1: { name: 'Ethereum', rpcUrl: 'https://ethereum-rpc.publicnode.com' },
  11155111: { name: 'Sepolia', rpcUrl: 'https://rpc.sepolia.org' },
}

export const CONTRACT_ADDRESSES = {
  1: null,
  11155111: '0x4f105ba0764c6f73502Df969a357467FE3361acb',
}

export const CONTRACT_ABI = [
  {
    type: 'constructor',
    inputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelOrder',
    inputs: [{ name: 'orderHash', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'createOrder',
    inputs: [
      { name: 'taker', type: 'address', internalType: 'address' },
      {
        name: 'makerAssets',
        type: 'tuple[]',
        internalType: 'struct OTCSwap.Asset[]',
        components: [
          { name: 'token', type: 'address', internalType: 'address' },
          { name: 'tokenId', type: 'uint256', internalType: 'uint256' },
          { name: 'amount', type: 'uint256', internalType: 'uint256' },
          { name: 'assetType', type: 'uint8', internalType: 'enum OTCSwap.AssetType' },
        ],
      },
      {
        name: 'takerAssets',
        type: 'tuple[]',
        internalType: 'struct OTCSwap.Asset[]',
        components: [
          { name: 'token', type: 'address', internalType: 'address' },
          { name: 'tokenId', type: 'uint256', internalType: 'uint256' },
          { name: 'amount', type: 'uint256', internalType: 'uint256' },
          { name: 'assetType', type: 'uint8', internalType: 'enum OTCSwap.AssetType' },
        ],
      },
      { name: 'expiration', type: 'uint256', internalType: 'uint256' },
      { name: 'salt', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: 'orderHash', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'fillOrder',
    inputs: [
      { name: 'maker', type: 'address', internalType: 'address' },
      { name: 'taker', type: 'address', internalType: 'address' },
      {
        name: 'makerAssets',
        type: 'tuple[]',
        internalType: 'struct OTCSwap.Asset[]',
        components: [
          { name: 'token', type: 'address', internalType: 'address' },
          { name: 'tokenId', type: 'uint256', internalType: 'uint256' },
          { name: 'amount', type: 'uint256', internalType: 'uint256' },
          { name: 'assetType', type: 'uint8', internalType: 'enum OTCSwap.AssetType' },
        ],
      },
      {
        name: 'takerAssets',
        type: 'tuple[]',
        internalType: 'struct OTCSwap.Asset[]',
        components: [
          { name: 'token', type: 'address', internalType: 'address' },
          { name: 'tokenId', type: 'uint256', internalType: 'uint256' },
          { name: 'amount', type: 'uint256', internalType: 'uint256' },
          { name: 'assetType', type: 'uint8', internalType: 'enum OTCSwap.AssetType' },
        ],
      },
      { name: 'expiration', type: 'uint256', internalType: 'uint256' },
      { name: 'salt', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'kill',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'killed',
    inputs: [],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'orderMakers',
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'orders',
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [{ name: '', type: 'uint8', internalType: 'enum OTCSwap.OrderStatus' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'Killed',
    inputs: [],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OrderCancelled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'maker', type: 'address', indexed: true, internalType: 'address' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OrderCreated',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'maker', type: 'address', indexed: true, internalType: 'address' },
      { name: 'taker', type: 'address', indexed: true, internalType: 'address' },
      {
        name: 'makerAssets',
        type: 'tuple[]',
        indexed: false,
        internalType: 'struct OTCSwap.Asset[]',
        components: [
          { name: 'token', type: 'address', internalType: 'address' },
          { name: 'tokenId', type: 'uint256', internalType: 'uint256' },
          { name: 'amount', type: 'uint256', internalType: 'uint256' },
          { name: 'assetType', type: 'uint8', internalType: 'enum OTCSwap.AssetType' },
        ],
      },
      {
        name: 'takerAssets',
        type: 'tuple[]',
        indexed: false,
        internalType: 'struct OTCSwap.Asset[]',
        components: [
          { name: 'token', type: 'address', internalType: 'address' },
          { name: 'tokenId', type: 'uint256', internalType: 'uint256' },
          { name: 'amount', type: 'uint256', internalType: 'uint256' },
          { name: 'assetType', type: 'uint8', internalType: 'enum OTCSwap.AssetType' },
        ],
      },
      { name: 'expiration', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'salt', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OrderFilled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true, internalType: 'bytes32' },
      { name: 'maker', type: 'address', indexed: true, internalType: 'address' },
      { name: 'taker', type: 'address', indexed: true, internalType: 'address' },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'ReentrancyGuardReentrantCall',
    inputs: [],
  },
]
