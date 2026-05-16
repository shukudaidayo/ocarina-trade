import { Interface } from 'ethers'

const OTC_ERROR_INTERFACE = new Interface([
  'error OnlySeaport(address caller)',
  'error UnauthorizedTaker(address fulfiller,address allowedTaker)',
  'error TokenNotWhitelisted(address token)',
  'error InvalidSignature()',
  'error MemoTooLong(uint256 length,uint256 maxLength)',
  'error AlreadyRegistered(bytes32 orderHash,address maker)',
  'error Expired(uint256 currentTime,uint256 endTime)',
  'error WrongZone(address provided,address expected)',
  'error WrongOrderType(uint8 provided,uint8 expected)',
  'error InvalidConduitKey(bytes32 conduitKey)',
  'error InvalidItemType(uint8 itemType)',
  'error InvalidNativeItem(address token,uint256 identifier)',
  'error InvalidERC20Identifier(uint256 identifier)',
  'error InvalidERC721Amount(uint256 amount)',
  'error InvalidRecipient(address recipient)',
  'error VariableAmount(uint256 startAmount,uint256 endAmount)',
  'error InvalidTokenStandard(address token,bytes4 interfaceId)',
  'error SeaportValidationFailed()',
  'error InvalidTime(uint256 startTime,uint256 endTime)',
  'error InvalidNativeOfferItem(address token,uint256 identifier,uint256 amount)',
  'error MissingItemAmount(uint8 itemType,address token,uint256 identifier)',
  'error InvalidCounter(uint256 providedCounter,uint256 currentCounter)',
  'error OrderNotRegistered(bytes32 orderHash,address offerer)',
  'error InvalidZoneHash(bytes32 zoneHash)',
  'error InvalidSeaport(address seaport)',
  'error InvalidWhitelistToken(address token)',
  'error DuplicateWhitelistToken(address token)',
  'error EmptyOffer()',
  'error EmptyConsideration()',
  'error TransferRestrictedToken(address token,bytes4 restriction)',
])

const LEGACY_SELECTOR_MESSAGES = {
  '0x82b42900': 'You are not the authorized taker for this offer.',
  '0x98d4901c': 'This order has been cancelled.',
}

const ITEM_TYPES = {
  0: 'native',
  1: 'ERC-20',
  2: 'ERC-721',
  3: 'ERC-1155',
  4: 'ERC-721 criteria',
  5: 'ERC-1155 criteria',
}

const ORDER_TYPES = {
  0: 'FULL_OPEN',
  1: 'PARTIAL_OPEN',
  2: 'FULL_RESTRICTED',
  3: 'PARTIAL_RESTRICTED',
}

const RESTRICTIONS = {
  '0xb45a3c0e': 'ERC-5192 locked',
  '0x0489b56f': 'ERC-5484 soulbound',
  '0x91a6262f': 'ERC-6454 non-transferable',
}

function shortAddress(address) {
  if (!address || address.length < 10) return String(address || '')
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatTime(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return String(value)
  return new Date(seconds * 1000).toLocaleString()
}

function collectErrorData(value, out = [], seen = new WeakSet()) {
  if (!value) return out
  if (typeof value === 'string') {
    const directHex = value.match(/^0x[0-9a-fA-F]{8,}$/)
    if (directHex) out.push(directHex[0])
    const embedded = value.match(/0x[0-9a-fA-F]{8,}/g)
    if (embedded) out.push(...embedded)
    return out
  }
  if (typeof value !== 'object') return out
  if (seen.has(value)) return out
  seen.add(value)

  if (typeof value.data === 'string') collectErrorData(value.data, out, seen)
  if (value.error) collectErrorData(value.error, out, seen)
  if (value.info) collectErrorData(value.info, out, seen)
  if (value.message) collectErrorData(value.message, out, seen)
  if (value.reason) collectErrorData(value.reason, out, seen)
  if (value.shortMessage) collectErrorData(value.shortMessage, out, seen)
  return out
}

function selectorOf(data) {
  return typeof data === 'string' && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null
}

function parseOtcError(err) {
  for (const data of collectErrorData(err)) {
    try {
      const parsed = OTC_ERROR_INTERFACE.parseError(data)
      if (parsed) return parsed
    } catch {}
  }
  return null
}

function itemTypeName(itemType) {
  return ITEM_TYPES[Number(itemType)] || `item type ${itemType}`
}

function orderTypeName(orderType) {
  return ORDER_TYPES[Number(orderType)] || `order type ${orderType}`
}

export function friendlyContractError(err) {
  const parsed = parseOtcError(err)
  if (parsed) {
    const args = parsed.args
    switch (parsed.name) {
      case 'OnlySeaport':
        return `This order can only be validated by Seaport. Caller was ${shortAddress(args.caller)}.`
      case 'UnauthorizedTaker':
        return `You are not the authorized taker for this offer. Required wallet: ${shortAddress(args.allowedTaker)}.`
      case 'TokenNotWhitelisted':
        return `This offer contains a non-whitelisted ERC-20 token: ${shortAddress(args.token)}.`
      case 'InvalidSignature':
        return 'The listing signature is invalid.'
      case 'MemoTooLong':
        return `The memo is too long (${args.length} bytes, max ${args.maxLength}).`
      case 'AlreadyRegistered':
        return `This offer is already registered for maker ${shortAddress(args.maker)}.`
      case 'Expired':
        return `This offer expired at ${formatTime(args.endTime)}.`
      case 'WrongZone':
        return `This order uses the wrong zone: ${shortAddress(args.provided)} instead of ${shortAddress(args.expected)}.`
      case 'WrongOrderType':
        return `This order uses ${orderTypeName(args.provided)}, but Ocarina requires ${orderTypeName(args.expected)}.`
      case 'InvalidConduitKey':
        return 'This order uses a conduit. Ocarina orders must approve and transfer through Seaport directly.'
      case 'InvalidItemType':
        return `This offer contains an unsupported ${itemTypeName(args.itemType)} item.`
      case 'InvalidNativeItem':
        return 'This native token item is malformed.'
      case 'InvalidERC20Identifier':
        return `This ERC-20 item has a token identifier (${args.identifier}); ERC-20 identifiers must be zero.`
      case 'InvalidERC721Amount':
        return `This ERC-721 item has amount ${args.amount}; ERC-721 amount must be 1.`
      case 'InvalidRecipient':
        return `All requested assets must be sent to the maker. Found recipient ${shortAddress(args.recipient)}.`
      case 'VariableAmount':
        return 'Ocarina does not support variable-price or partial-amount Seaport items.'
      case 'InvalidTokenStandard':
        return `Token ${shortAddress(args.token)} does not support the declared NFT standard.`
      case 'SeaportValidationFailed':
        return 'Seaport rejected the order signature during registration.'
      case 'InvalidTime':
        return 'The order start time must be before or equal to the expiration time.'
      case 'InvalidNativeOfferItem':
        return 'The maker cannot offer native ETH; native ETH is only supported on the taker side.'
      case 'MissingItemAmount':
        return `This ${itemTypeName(args.itemType)} item has a zero amount.`
      case 'InvalidCounter':
        return `The maker's Seaport counter changed. Expected ${args.currentCounter}, got ${args.providedCounter}.`
      case 'OrderNotRegistered':
        return 'This order was not registered with Ocarina.'
      case 'InvalidZoneHash':
        return 'The taker address is not canonically encoded in zoneHash.'
      case 'InvalidSeaport':
        return `Invalid Seaport contract address: ${shortAddress(args.seaport)}.`
      case 'InvalidWhitelistToken':
        return `Invalid whitelist token address: ${shortAddress(args.token)}.`
      case 'DuplicateWhitelistToken':
        return `Duplicate whitelist token: ${shortAddress(args.token)}.`
      case 'EmptyOffer':
        return 'The offer side cannot be empty.'
      case 'EmptyConsideration':
        return 'The requested side cannot be empty.'
      case 'TransferRestrictedToken': {
        const restriction = RESTRICTIONS[String(args.restriction).toLowerCase()] || 'non-transferable'
        return `This offer contains a ${restriction} NFT: ${shortAddress(args.token)}.`
      }
      default:
        return null
    }
  }

  for (const data of collectErrorData(err)) {
    const selector = selectorOf(data)
    if (selector && LEGACY_SELECTOR_MESSAGES[selector]) return LEGACY_SELECTOR_MESSAGES[selector]
  }

  return null
}
