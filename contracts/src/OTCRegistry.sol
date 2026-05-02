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
    // Keyed by (orderHash, maker) so a front-runner cannot permanently brick a
    // victim's orderHash by squatting the slot with a self-signed registration.
    mapping(bytes32 => mapping(address => bool)) public registered;
    address public immutable seaport;

    uint256 public constant MAX_MEMO_LENGTH = 280;

    // Signs (orderHash, seaportSignature, memo). orderHash is derived onchain
    // from components via SeaportInterface.getOrderHash, so all components fields are
    // transitively bound. seaportSignature is bound directly to prevent a
    // front-runner from substituting a bad Seaport sig using the maker's reg sig.
    bytes32 private constant _REGISTRATION_TYPEHASH =
        keccak256("OrderRegistration(bytes32 orderHash,bytes seaportSignature,string memo)");

    error Unauthorized();
    error TokenNotWhitelisted(address token);
    error InvalidSignature();
    error MemoTooLong();
    error AlreadyRegistered();
    error Expired();
    error WrongZone();
    error WrongOrderType();
    error InvalidConduitKey();
    error InvalidItemType(ItemType itemType);
    error InvalidNativeItem();
    error InvalidERC20Identifier();
    error InvalidERC721Amount(uint256 amount);
    error InvalidRecipient(address recipient);
    error VariableAmount(uint256 startAmount, uint256 endAmount);
    error InvalidTokenStandard(address token, bytes4 interfaceId);
    error SeaportValidationFailed();

    event OrderRegistered(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        OrderComponents components,
        bytes seaportSignature,
        string memo
    );

    constructor(address[] memory _tokens, address _seaport) {
        whitelistedTokens = _tokens;
        for (uint256 i = 0; i < _tokens.length; i++) {
            whitelistedERC20[_tokens[i]] = true;
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

    /// @notice Register a signed order for public discovery.
    ///
    /// Accepts the full Seaport OrderComponents and delegates hash derivation to
    /// the Seaport contract via SeaportInterface.getOrderHash — no EIP-712 reimplementation.
    /// Asserts zone == address(this) and orderType == FULL_RESTRICTED onchain, so
    /// the event log is trustworthy without client-side cross-checks. The maker's
    /// EIP-712 registration signature covers (orderHash, seaportSignature, memo),
    /// binding the Seaport signature to the publication and preventing a front-runner
    /// from substituting a bad seaportSignature using the maker's registration sig.
    function registerOrder(OrderRegistration calldata reg) external {
        if (bytes(reg.memo).length > MAX_MEMO_LENGTH) revert MemoTooLong();
        if (block.timestamp > reg.components.endTime) revert Expired();
        if (reg.components.zone != address(this)) revert WrongZone();
        if (reg.components.orderType != OrderType.FULL_RESTRICTED) revert WrongOrderType();
        if (reg.components.conduitKey != bytes32(0)) revert InvalidConduitKey();

        for (uint256 i = 0; i < reg.components.offer.length; i++) {
            _checkFixedAmount(reg.components.offer[i].startAmount, reg.components.offer[i].endAmount);
            _checkItem(
                reg.components.offer[i].itemType,
                reg.components.offer[i].token,
                reg.components.offer[i].identifierOrCriteria,
                reg.components.offer[i].startAmount
            );
        }
        for (uint256 i = 0; i < reg.components.consideration.length; i++) {
            _checkRecipient(reg.components.consideration[i].recipient, reg.components.offerer);
            _checkFixedAmount(
                reg.components.consideration[i].startAmount, reg.components.consideration[i].endAmount
            );
            _checkItem(
                reg.components.consideration[i].itemType,
                reg.components.consideration[i].token,
                reg.components.consideration[i].identifierOrCriteria,
                reg.components.consideration[i].startAmount
            );
        }

        // Delegate hash derivation to the immutable Seaport contract.
        bytes32 orderHash = SeaportInterface(seaport).getOrderHash(reg.components);
        address maker = reg.components.offerer;

        if (registered[orderHash][maker]) revert AlreadyRegistered();

        // Effect before interaction: setting the slot before the signature check
        // closes an ERC-1271 reentrancy loophole where a malicious maker contract
        // could re-enter during signature validation and emit duplicate events.
        registered[orderHash][maker] = true;

        bytes32 structHash = keccak256(
            abi.encode(_REGISTRATION_TYPEHASH, orderHash, keccak256(reg.seaportSignature), keccak256(bytes(reg.memo)))
        );
        bytes32 digest = _hashTypedData(structHash);

        if (!SignatureCheckerLib.isValidSignatureNowCalldata(maker, digest, reg.signature)) revert InvalidSignature();

        // Validate the Seaport signature via Seaport itself. This prevents publishing
        // an unfillable offer and — as a side effect — marks the order pre-validated in
        // Seaport's storage, reducing taker gas at fill time (Seaport skips sig
        // re-verification for pre-validated orders).
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
                totalOriginalConsiderationItems: reg.components.consideration.length
            }),
            signature: reg.seaportSignature
        });
        if (!SeaportInterface(seaport).validate(orders)) revert SeaportValidationFailed();

        address taker = address(uint160(uint256(reg.components.zoneHash)));

        emit OrderRegistered(orderHash, maker, taker, reg.components, reg.seaportSignature, reg.memo);
    }

    /// @notice Called by Seaport before token transfers. Enforces taker restriction pre-transfer.
    function authorizeOrder(ZoneParameters calldata zoneParameters) external view returns (bytes4) {
        if (msg.sender != seaport) revert Unauthorized();

        address allowedTaker = address(uint160(uint256(zoneParameters.zoneHash)));
        if (allowedTaker != address(0) && zoneParameters.fulfiller != allowedTaker) {
            revert Unauthorized();
        }
        return this.authorizeOrder.selector;
    }

    /// @notice Called by Seaport after token transfers. Enforces item shape and recipients.
    function validateOrder(ZoneParameters calldata zoneParameters) external view returns (bytes4) {
        if (msg.sender != seaport) revert Unauthorized();

        for (uint256 i = 0; i < zoneParameters.offer.length; i++) {
            _checkItem(
                zoneParameters.offer[i].itemType,
                zoneParameters.offer[i].token,
                zoneParameters.offer[i].identifier,
                zoneParameters.offer[i].amount
            );
        }

        for (uint256 i = 0; i < zoneParameters.consideration.length; i++) {
            _checkRecipient(zoneParameters.consideration[i].recipient, zoneParameters.offerer);
            _checkItem(
                zoneParameters.consideration[i].itemType,
                zoneParameters.consideration[i].token,
                zoneParameters.consideration[i].identifier,
                zoneParameters.consideration[i].amount
            );
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

    function _checkFixedAmount(uint256 startAmount, uint256 endAmount) internal pure {
        if (startAmount != endAmount) revert VariableAmount(startAmount, endAmount);
    }

    function _checkRecipient(address recipient, address offerer) internal pure {
        if (recipient != offerer) revert InvalidRecipient(recipient);
    }

    function _checkItem(ItemType itemType, address token, uint256 identifier, uint256 amount) internal view {
        if (itemType == ItemType.NATIVE) {
            if (token != address(0) || identifier != 0) revert InvalidNativeItem();
            return;
        }

        if (itemType == ItemType.ERC20) {
            if (identifier != 0) revert InvalidERC20Identifier();
            _checkWhitelist(token);
            return;
        }

        _checkItemAmount(itemType, amount);

        if (itemType == ItemType.ERC721 || itemType == ItemType.ERC721_WITH_CRITERIA) {
            _checkSupportsInterface(token, 0x80ac58cd);
        } else if (itemType == ItemType.ERC1155 || itemType == ItemType.ERC1155_WITH_CRITERIA) {
            _checkSupportsInterface(token, 0xd9b67a26);
        } else {
            revert InvalidItemType(itemType);
        }
    }

    function _checkItemAmount(ItemType itemType, uint256 amount) internal pure {
        if ((itemType == ItemType.ERC721 || itemType == ItemType.ERC721_WITH_CRITERIA) && amount != 1) {
            revert InvalidERC721Amount(amount);
        }
    }

    function _checkSupportsInterface(address token, bytes4 interfaceId) internal view {
        try IERC165(token).supportsInterface(interfaceId) returns (bool supported) {
            if (supported) return;
        } catch {}

        revert InvalidTokenStandard(token, interfaceId);
    }
}
