import { Interface } from 'ethers'

const OTC_ERROR_INTERFACE = new Interface([
  'error OnlySeaport(address caller)',
  'error UnauthorizedTaker(address fulfiller,address allowedTaker)',
  'error TokenNotWhitelisted(address token)',
  'error InvalidSignature()',
  'error MemoTooLong(uint256 length,uint256 maxLength)',
  'error AlreadyRegistered(bytes32 orderHash,address maker)',
  'error Expired(uint256 currentTime,uint256 endTime)',
  'error FutureStartTime(uint256 currentTime,uint256 startTime)',
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
  'error InvalidConsiderationCount(uint256 providedCount,uint256 originalCount)',
  'error UnexpectedExtraData()',
  'error MissingTipAuthorization()',
  'error TipAuthorizationExpired(uint256 currentTime,uint256 deadline)',
  'error InvalidTipSignature()',
])

const SEAPORT_ERROR_INTERFACE = new Interface([
  'error OrderAlreadyFilled(bytes32 orderHash)',
  'error InvalidTime(uint256 startTime,uint256 endTime)',
  'error InvalidConduit(bytes32 conduitKey,address conduit)',
  'error MissingOriginalConsiderationItems()',
  'error ConsiderationLengthNotEqualToTotalOriginal()',
  'error InvalidCallToConduit(address conduit)',
  'error ConsiderationNotMet(uint256 orderIndex,uint256 considerationIndex,uint256 shortfallAmount)',
  'error InsufficientNativeTokensSupplied()',
  'error NativeTokenTransferGenericFailure(address account,uint256 amount)',
  'error PartialFillsNotEnabledForOrder()',
  'error OrderIsCancelled(bytes32 orderHash)',
  'error OrderPartiallyFilled(bytes32 orderHash)',
  'error CannotCancelOrder()',
  'error BadFraction()',
  'error InvalidMsgValue(uint256 value)',
  'error InvalidBasicOrderParameterEncoding()',
  'error NoSpecifiedOrdersAvailable()',
  'error InvalidNativeOfferItem()',
  'error BadSignatureV(uint8 v)',
  'error InvalidSigner()',
  'error InvalidSignature()',
  'error BadContractSignature()',
  'error OrderCriteriaResolverOutOfRange(uint8 side)',
  'error UnresolvedOfferCriteria(uint256 orderIndex,uint256 offerIndex)',
  'error UnresolvedConsiderationCriteria(uint256 orderIndex,uint256 considerationIndex)',
  'error OfferCriteriaResolverOutOfRange()',
  'error ConsiderationCriteriaResolverOutOfRange()',
  'error CriteriaNotEnabledForItem()',
  'error InvalidProof()',
  'error InvalidERC721TransferAmount(uint256 amount)',
  'error MissingItemAmount()',
  'error UnusedItemParameters()',
  'error TokenTransferGenericFailure(address token,address from,address to,uint256 identifier,uint256 amount)',
  'error ERC1155BatchTransferGenericFailure(address token,address from,address to,uint256[] identifiers,uint256[] amounts)',
  'error BadReturnValueFromERC20OnTransfer(address token,address from,address to,uint256 amount)',
  'error NoContract(address account)',
  'error Invalid1155BatchTransferEncoding()',
  'error InvalidRestrictedOrder(bytes32 orderHash)',
  'error InvalidContractOrder(bytes32 orderHash)',
  'error MissingFulfillmentComponentOnAggregation(uint8 side)',
  'error OfferAndConsiderationRequiredOnFulfillment()',
  'error MismatchedFulfillmentOfferAndConsiderationComponents(uint256 fulfillmentIndex)',
  'error InvalidFulfillmentComponentData()',
  'error InexactFraction()',
  'error NoReentrantCalls()',
  'error InvalidItemType()',
  'error InvalidERC721Recipient(address recipient)',
  'error ERC721ReceiverErrorRevertBytes(bytes reason,address receiver,address sender,uint256 identifier)',
  'error ERC721ReceiverErrorRevertString(string reason,address receiver,address sender,uint256 identifier)',
  'error InvalidERC20Identifier()',
  'error RecipientCannotBeZeroAddress()',
  'error ConduitErrorRevertString(string reason,bytes32 conduitKey,address conduit)',
  'error ConduitErrorRevertBytes(bytes reason,bytes32 conduitKey,address conduit)',
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

function parseSeaportError(err) {
  for (const data of collectErrorData(err)) {
    try {
      const parsed = SEAPORT_ERROR_INTERFACE.parseError(data)
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

function sideName(side) {
  const sideValue = Number(side)
  if (sideValue === 0) return 'offer'
  if (sideValue === 1) return 'consideration'
  return `side ${side}`
}

function truncateReason(reason) {
  if (!reason) return ''
  const text = String(reason)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

function friendlyOtcParsedError(parsed) {
  if (!parsed) return null
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
      return `The memo is too long (${args[0]} bytes, max ${args.maxLength}).`
    case 'AlreadyRegistered':
      return `This offer is already registered for maker ${shortAddress(args.maker)}.`
    case 'Expired':
      return `This offer expired at ${formatTime(args.endTime)}.`
    case 'FutureStartTime':
      return `This offer is not active yet. It starts at ${formatTime(args.startTime)}.`
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
    case 'InvalidConsiderationCount':
      return `This fill is missing requested consideration items. Expected at least ${args.originalCount}, got ${args.providedCount}.`
    case 'UnexpectedExtraData':
      return 'This fill included tip authorization data, but no tips were appended.'
    case 'MissingTipAuthorization':
      return 'A support tip was appended without the required tip authorization signature.'
    case 'TipAuthorizationExpired':
      return `The support tip signature expired at ${formatTime(args.deadline)}. Try accepting the offer again.`
    case 'InvalidTipSignature':
      return 'The support tip signature is invalid for this wallet or tip set.'
    default:
      return null
  }
}

function friendlySeaportParsedError(parsed) {
  if (!parsed) return null
  const args = parsed.args
  switch (parsed.name) {
    case 'OrderAlreadyFilled':
      return 'This offer has already been filled.'
    case 'InvalidTime':
      return `This Seaport order is not currently active. It is valid from ${formatTime(args.startTime)} to ${formatTime(args.endTime)}.`
    case 'InvalidConduit':
      return `This Seaport order references an unavailable conduit: ${shortAddress(args.conduit)}.`
    case 'MissingOriginalConsiderationItems':
      return 'This fill is missing original consideration items.'
    case 'ConsiderationLengthNotEqualToTotalOriginal':
      return 'This fill has an invalid consideration item count.'
    case 'InvalidCallToConduit':
      return `Seaport could not call conduit ${shortAddress(args.conduit)}.`
    case 'ConsiderationNotMet':
      return `Seaport could not satisfy consideration item ${args.considerationIndex}.`
    case 'InsufficientNativeTokensSupplied':
      return 'Not enough native token was supplied to accept this offer.'
    case 'NativeTokenTransferGenericFailure':
      return `Native token transfer of ${args.amount} failed for ${shortAddress(args.account)}.`
    case 'PartialFillsNotEnabledForOrder':
      return 'Partial fills are not enabled for this Seaport order.'
    case 'OrderIsCancelled':
      return 'This offer has been cancelled.'
    case 'OrderPartiallyFilled':
      return 'This offer was partially filled and cannot be accepted here.'
    case 'CannotCancelOrder':
      return 'Only the maker or zone can cancel this Seaport order.'
    case 'BadFraction':
      return 'This partial fill fraction is invalid.'
    case 'InvalidMsgValue':
      return 'This fill sent an invalid native token amount.'
    case 'InvalidBasicOrderParameterEncoding':
      return 'The Seaport fill payload is malformed.'
    case 'NoSpecifiedOrdersAvailable':
      return 'No supplied Seaport orders are currently fillable.'
    case 'InvalidNativeOfferItem':
      return 'Seaport does not allow native token offer items in this fill path.'
    case 'BadSignatureV':
      return `The Seaport signature has an invalid recovery value (${args.v}).`
    case 'InvalidSigner':
      return 'The Seaport signature was not produced by the maker.'
    case 'InvalidSignature':
      return 'The Seaport order signature is invalid.'
    case 'BadContractSignature':
      return 'The maker contract rejected the Seaport signature.'
    case 'OrderCriteriaResolverOutOfRange':
      return `The selected criteria ${sideName(args.side)} item does not belong to this order.`
    case 'UnresolvedOfferCriteria':
      return `Choose a token ID for offer criteria item ${args.offerIndex} before accepting this offer.`
    case 'UnresolvedConsiderationCriteria':
      return `Choose a token ID for requested criteria item ${args.considerationIndex} before accepting this offer.`
    case 'OfferCriteriaResolverOutOfRange':
      return 'The selected offer criteria item is out of range.'
    case 'ConsiderationCriteriaResolverOutOfRange':
      return 'The selected consideration criteria item is out of range.'
    case 'CriteriaNotEnabledForItem':
      return 'Criteria resolution was provided for an item that does not use criteria.'
    case 'InvalidProof':
      return 'The selected token ID does not match the criteria proof for this offer.'
    case 'InvalidERC721TransferAmount':
      return `Seaport tried to transfer an ERC-721 amount of ${args.amount}; ERC-721 amount must be 1.`
    case 'MissingItemAmount':
      return 'Seaport cannot transfer an item with zero amount.'
    case 'UnusedItemParameters':
      return 'This transfer includes parameters Seaport does not allow for that item type.'
    case 'TokenTransferGenericFailure':
      return `Seaport could not transfer token ${shortAddress(args.token)}. The owner may no longer hold it, approval may be missing, or the token may block transfers.`
    case 'ERC1155BatchTransferGenericFailure':
      return `Seaport could not batch transfer ERC-1155 token ${shortAddress(args.token)}. The owner may no longer hold the items, approval may be missing, or the token may block transfers.`
    case 'BadReturnValueFromERC20OnTransfer':
      return `ERC-20 transfer failed for token ${shortAddress(args.token)}.`
    case 'NoContract':
      return `Expected a token contract at ${shortAddress(args.account)}, but no contract code was found.`
    case 'Invalid1155BatchTransferEncoding':
      return 'The ERC-1155 batch transfer payload is malformed.'
    case 'InvalidRestrictedOrder':
      return 'The Ocarina zone rejected this restricted order.'
    case 'InvalidContractOrder':
      return 'Seaport rejected this contract order.'
    case 'MissingFulfillmentComponentOnAggregation':
      return `This fill is missing ${sideName(args.side)} fulfillment components.`
    case 'OfferAndConsiderationRequiredOnFulfillment':
      return 'This fill must include both offered and requested assets.'
    case 'MismatchedFulfillmentOfferAndConsiderationComponents':
      return `Fulfillment component ${args.fulfillmentIndex} does not match between offer and consideration.`
    case 'InvalidFulfillmentComponentData':
      return 'The Seaport fulfillment component data is invalid.'
    case 'InexactFraction':
      return 'This partial fill fraction does not divide the order amounts cleanly.'
    case 'NoReentrantCalls':
      return 'Seaport rejected a reentrant call.'
    case 'InvalidItemType':
      return 'This Seaport transfer uses an unsupported item type.'
    case 'InvalidERC721Recipient':
      return `The ERC-721 recipient ${shortAddress(args.recipient)} cannot receive this token.`
    case 'ERC721ReceiverErrorRevertBytes':
      return 'The ERC-721 recipient contract rejected the transfer.'
    case 'ERC721ReceiverErrorRevertString':
      return `The ERC-721 recipient contract rejected the transfer: ${truncateReason(args.reason)}`
    case 'InvalidERC20Identifier':
      return 'This ERC-20 transfer includes a token identifier; ERC-20 identifiers must be zero.'
    case 'RecipientCannotBeZeroAddress':
      return 'This transfer is trying to send to the zero address.'
    case 'ConduitErrorRevertString':
      return `Seaport conduit ${shortAddress(args.conduit)} reverted: ${truncateReason(args.reason)}`
    case 'ConduitErrorRevertBytes':
      return `Seaport conduit ${shortAddress(args.conduit)} reverted.`
    default:
      return null
  }
}

export function friendlyContractError(err, options = {}) {
  const decoders = options.preferSeaport
    ? [[parseSeaportError, friendlySeaportParsedError], [parseOtcError, friendlyOtcParsedError]]
    : [[parseOtcError, friendlyOtcParsedError], [parseSeaportError, friendlySeaportParsedError]]

  for (const [parse, format] of decoders) {
    const parsed = parse(err)
    const message = format(parsed)
    if (message) return message
  }

  for (const data of collectErrorData(err)) {
    const selector = selectorOf(data)
    if (selector && LEGACY_SELECTOR_MESSAGES[selector]) return LEGACY_SELECTOR_MESSAGES[selector]
  }

  return null
}
