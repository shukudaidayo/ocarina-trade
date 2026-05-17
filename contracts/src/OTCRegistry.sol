// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import {ZoneInterface} from "seaport-types/interfaces/ZoneInterface.sol";
import {IERC165} from "seaport-types/interfaces/IERC165.sol";
import {SeaportInterface} from "seaport-types/interfaces/SeaportInterface.sol";
import {
    ZoneParameters,
    Schema,
    OrderComponents,
    OrderParameters,
    Order,
    OfferItem,
    ConsiderationItem
} from "seaport-types/lib/ConsiderationStructs.sol";
import {ItemType, OrderType} from "seaport-types/lib/ConsiderationEnums.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

struct OrderRegistration {
    OrderComponents components;
    bytes seaportSignature;
    bytes signature;
    string memo;
}

contract OTCRegistry is ZoneInterface, EIP712 {
    address[] private whitelistedTokens;
    mapping(address => bool) public whitelistedERC20;
    // Keyed by Seaport order hash, which commits to the maker via offerer.
    // Used both to block duplicate publication and as the settlement allowlist.
    mapping(bytes32 => bool) public registered;
    address public immutable seaport;

    uint256 public constant MAX_MEMO_LENGTH = 280;

    // Signs (orderHash, seaportSignature, memo). orderHash is derived onchain
    // from components via SeaportInterface.getOrderHash, so all components fields are
    // transitively bound. seaportSignature is bound directly to prevent a
    // front-runner from substituting a bad Seaport sig using the maker's reg sig.
    bytes32 private constant _REGISTRATION_TYPEHASH =
        keccak256("OrderRegistration(bytes32 orderHash,bytes seaportSignature,string memo)");

    error OnlySeaport(address caller);
    error UnauthorizedTaker(address fulfiller, address allowedTaker);
    error TokenNotWhitelisted(address token);
    error InvalidSignature();
    error MemoTooLong(uint256 length, uint256 maxLength);
    error AlreadyRegistered(bytes32 orderHash, address maker);
    error Expired(uint256 currentTime, uint256 endTime);
    error FutureStartTime(uint256 currentTime, uint256 startTime);
    error WrongZone(address provided, address expected);
    error WrongOrderType(OrderType provided, OrderType expected);
    error InvalidConduitKey(bytes32 conduitKey);
    error InvalidItemType(ItemType itemType);
    error InvalidNativeItem(address token, uint256 identifier);
    error InvalidERC20Identifier(uint256 identifier);
    error InvalidERC721Amount(uint256 amount);
    error InvalidRecipient(address recipient);
    error VariableAmount(uint256 startAmount, uint256 endAmount);
    error InvalidTokenStandard(address token, bytes4 interfaceId);
    error SeaportValidationFailed();
    error InvalidTime(uint256 startTime, uint256 endTime);
    error InvalidNativeOfferItem(address token, uint256 identifier, uint256 amount);
    error MissingItemAmount(ItemType itemType, address token, uint256 identifier);
    error InvalidCounter(uint256 providedCounter, uint256 currentCounter);
    error OrderNotRegistered(bytes32 orderHash, address offerer);
    error InvalidZoneHash(bytes32 zoneHash);
    error InvalidSeaport(address seaport);
    error InvalidWhitelistToken(address token);
    error DuplicateWhitelistToken(address token);
    error EmptyOffer();
    error EmptyConsideration();

    event OrderRegistered(
        bytes32 indexed orderHash, address indexed maker, address indexed taker, OrderComponents components, string memo
    );

    constructor(address[] memory _tokens, address _seaport) {
        if (_seaport == address(0) || _seaport.code.length == 0) revert InvalidSeaport(_seaport);
        whitelistedTokens = _tokens;
        uint256 tokenCount = _tokens.length;
        for (uint256 i = 0; i < tokenCount;) {
            if (_tokens[i] == address(0)) revert InvalidWhitelistToken(_tokens[i]);
            if (whitelistedERC20[_tokens[i]]) revert DuplicateWhitelistToken(_tokens[i]);
            whitelistedERC20[_tokens[i]] = true;
            unchecked {
                ++i;
            }
        }
        seaport = _seaport;
    }

    function _domainNameAndVersion() internal pure override returns (string memory name, string memory version) {
        name = "OTCRegistry";
        version = "1";
    }

    /// @notice Returns the EIP-712 domain separator used to verify registrations on this chain.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator();
    }

    /// @notice Returns the full list of whitelisted ERC-20 addresses.
    function getWhitelistedTokens() external view returns (address[] memory) {
        return whitelistedTokens;
    }

    /// @notice Register and pre-validate an order for public discovery.
    ///
    /// Accepts the full Seaport OrderComponents and delegates hash derivation to
    /// the Seaport contract via SeaportInterface.getOrderHash — no EIP-712 reimplementation.
    /// Requires the order's counter to match Seaport's live counter and asserts
    /// zone == address(this) and orderType == FULL_RESTRICTED onchain, so the event
    /// log is trustworthy without client-side cross-checks. A successful registration
    /// is required for fulfillment through validateOrder. The maker's EIP-712
    /// registration signature covers (orderHash, seaportSignature, memo), binding
    /// the Seaport signature to the publication and preventing a front-runner from
    /// substituting a bad seaportSignature using the maker's registration sig.
    function registerOrder(OrderRegistration calldata reg) external {
        uint256 memoLength = bytes(reg.memo).length;
        if (memoLength > MAX_MEMO_LENGTH) revert MemoTooLong(memoLength, MAX_MEMO_LENGTH);
        if (reg.components.startTime > reg.components.endTime) {
            revert InvalidTime(reg.components.startTime, reg.components.endTime);
        }
        if (reg.components.startTime > block.timestamp) {
            revert FutureStartTime(block.timestamp, reg.components.startTime);
        }
        if (block.timestamp > reg.components.endTime) revert Expired(block.timestamp, reg.components.endTime);
        if (reg.components.zone != address(this)) revert WrongZone(reg.components.zone, address(this));
        if (reg.components.orderType != OrderType.FULL_RESTRICTED) {
            revert WrongOrderType(reg.components.orderType, OrderType.FULL_RESTRICTED);
        }
        if (reg.components.conduitKey != bytes32(0)) revert InvalidConduitKey(reg.components.conduitKey);
        uint256 offerCount = reg.components.offer.length;
        uint256 considerationCount = reg.components.consideration.length;
        if (offerCount == 0) revert EmptyOffer();
        if (considerationCount == 0) revert EmptyConsideration();
        _checkZoneHash(reg.components.zoneHash);
        uint256 currentCounter = SeaportInterface(seaport).getCounter(reg.components.offerer);
        if (reg.components.counter != currentCounter) {
            revert InvalidCounter(reg.components.counter, currentCounter);
        }

        for (uint256 i = 0; i < offerCount;) {
            if (reg.components.offer[i].itemType == ItemType.NATIVE) {
                revert InvalidNativeOfferItem(
                    reg.components.offer[i].token,
                    reg.components.offer[i].identifierOrCriteria,
                    reg.components.offer[i].startAmount
                );
            }
            _checkFixedAmount(reg.components.offer[i].startAmount, reg.components.offer[i].endAmount);
            _checkItem(
                reg.components.offer[i].itemType,
                reg.components.offer[i].token,
                reg.components.offer[i].identifierOrCriteria,
                reg.components.offer[i].startAmount
            );
            unchecked {
                ++i;
            }
        }
        for (uint256 i = 0; i < considerationCount;) {
            _checkRecipient(reg.components.consideration[i].recipient, reg.components.offerer);
            _checkFixedAmount(reg.components.consideration[i].startAmount, reg.components.consideration[i].endAmount);
            _checkItem(
                reg.components.consideration[i].itemType,
                reg.components.consideration[i].token,
                reg.components.consideration[i].identifierOrCriteria,
                reg.components.consideration[i].startAmount
            );
            unchecked {
                ++i;
            }
        }

        // Delegate hash derivation to the immutable Seaport contract.
        bytes32 orderHash = SeaportInterface(seaport).getOrderHash(reg.components);
        address maker = reg.components.offerer;

        if (registered[orderHash]) revert AlreadyRegistered(orderHash, maker);

        // Effect before interaction: setting the slot before the signature check
        // closes an ERC-1271 reentrancy loophole where a malicious maker contract
        // could re-enter during signature validation and emit duplicate events.
        registered[orderHash] = true;

        bytes32 structHash = keccak256(
            abi.encode(_REGISTRATION_TYPEHASH, orderHash, keccak256(reg.seaportSignature), keccak256(bytes(reg.memo)))
        );
        bytes32 digest = _hashTypedData(structHash);

        if (!SignatureCheckerLib.isValidSignatureNowCalldata(maker, digest, reg.signature)) revert InvalidSignature();

        // Validate the Seaport signature/status via Seaport itself and, as a side
        // effect, mark the order pre-validated in Seaport's storage so takers can
        // fulfill with an empty signature. This does not prove the maker still
        // holds or has approved the offered assets; Seaport enforces that during
        // fulfillment transfers.
        Order[] memory orders = new Order[](1);
        orders[0] = Order({
            parameters: OrderParameters({
                offerer: reg.components.offerer,
                zone: reg.components.zone,
                offer: reg.components.offer,
                consideration: reg.components.consideration,
                orderType: reg.components.orderType,
                startTime: reg.components.startTime,
                endTime: reg.components.endTime,
                zoneHash: reg.components.zoneHash,
                salt: reg.components.salt,
                conduitKey: reg.components.conduitKey,
                totalOriginalConsiderationItems: considerationCount
            }),
            signature: reg.seaportSignature
        });
        if (!SeaportInterface(seaport).validate(orders)) revert SeaportValidationFailed();

        address taker = address(uint160(uint256(reg.components.zoneHash)));

        emit OrderRegistered(orderHash, maker, taker, reg.components, reg.memo);
    }

    /// @notice Called by Seaport before token transfers. Enforces taker restriction pre-transfer.
    function authorizeOrder(ZoneParameters calldata zoneParameters) external view returns (bytes4) {
        if (msg.sender != seaport) revert OnlySeaport(msg.sender);

        address allowedTaker = address(uint160(uint256(zoneParameters.zoneHash)));
        if (allowedTaker != address(0) && zoneParameters.fulfiller != allowedTaker) {
            revert UnauthorizedTaker(zoneParameters.fulfiller, allowedTaker);
        }
        return this.authorizeOrder.selector;
    }

    /// @notice Called by Seaport after token transfers. Enforces prior registration and ERC-20 policy.
    function validateOrder(ZoneParameters calldata zoneParameters) external view returns (bytes4) {
        if (msg.sender != seaport) revert OnlySeaport(msg.sender);
        if (!registered[zoneParameters.orderHash]) {
            revert OrderNotRegistered(zoneParameters.orderHash, zoneParameters.offerer);
        }

        uint256 offerCount = zoneParameters.offer.length;
        for (uint256 i = 0; i < offerCount;) {
            _checkERC20Whitelist(zoneParameters.offer[i].itemType, zoneParameters.offer[i].token);
            unchecked {
                ++i;
            }
        }

        uint256 considerationCount = zoneParameters.consideration.length;
        for (uint256 i = 0; i < considerationCount;) {
            _checkERC20Whitelist(zoneParameters.consideration[i].itemType, zoneParameters.consideration[i].token);
            unchecked {
                ++i;
            }
        }

        return this.validateOrder.selector;
    }

    function getSeaportMetadata() external pure returns (string memory name, Schema[] memory schemas) {
        name = "OTCRegistry";
        schemas = new Schema[](0);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(ZoneInterface).interfaceId || interfaceId == 0x01ffc9a7; // ERC-165
    }

    function _checkWhitelist(address token) internal view {
        if (!whitelistedERC20[token]) revert TokenNotWhitelisted(token);
    }

    function _checkERC20Whitelist(ItemType itemType, address token) internal view {
        if (itemType == ItemType.ERC20) _checkWhitelist(token);
    }

    function _checkFixedAmount(uint256 startAmount, uint256 endAmount) internal pure {
        if (startAmount != endAmount) revert VariableAmount(startAmount, endAmount);
    }

    function _checkRecipient(address recipient, address offerer) internal pure {
        if (recipient != offerer) revert InvalidRecipient(recipient);
    }

    function _checkZoneHash(bytes32 zoneHash) internal pure {
        if (uint256(zoneHash) >> 160 != 0) revert InvalidZoneHash(zoneHash);
    }

    function _checkItem(ItemType itemType, address token, uint256 identifier, uint256 amount) internal view {
        if (amount == 0) revert MissingItemAmount(itemType, token, identifier);

        if (itemType == ItemType.NATIVE) {
            if (token != address(0) || identifier != 0) revert InvalidNativeItem(token, identifier);
            return;
        }

        if (itemType == ItemType.ERC20) {
            if (identifier != 0) revert InvalidERC20Identifier(identifier);
            _checkWhitelist(token);
            return;
        }

        if (itemType == ItemType.ERC721 || itemType == ItemType.ERC721_WITH_CRITERIA) {
            if (amount != 1) revert InvalidERC721Amount(amount);
            _checkSupportsInterface(token, 0x80ac58cd);
        } else if (itemType == ItemType.ERC1155 || itemType == ItemType.ERC1155_WITH_CRITERIA) {
            _checkSupportsInterface(token, 0xd9b67a26);
        } else {
            revert InvalidItemType(itemType);
        }
    }

    function _checkSupportsInterface(address token, bytes4 interfaceId) internal view {
        try IERC165(token).supportsInterface(interfaceId) returns (bool supported) {
            if (supported) {
                try IERC165(token).supportsInterface(0xffffffff) returns (bool invalidSupported) {
                    if (!invalidSupported) return;
                } catch {}
            }
        } catch {}

        revert InvalidTokenStandard(token, interfaceId);
    }
}
