// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ZoneInterface} from "seaport-types/interfaces/ZoneInterface.sol";
import {ZoneParameters, SpentItem, ReceivedItem, Schema} from "seaport-types/lib/ConsiderationStructs.sol";
import {ItemType} from "seaport-types/lib/ConsiderationEnums.sol";

contract OTCZone is ZoneInterface {
    address[] private whitelistedTokens;
    mapping(address => bool) public whitelistedERC20;

    error Unauthorized();
    error TokenNotWhitelisted(address token);

    event OrderRegistered(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        string orderURI
    );

    constructor(address[] memory _tokens) {
        whitelistedTokens = _tokens;
        for (uint256 i = 0; i < _tokens.length; i++) {
            whitelistedERC20[_tokens[i]] = true;
        }
    }

    /// @notice Returns the full list of whitelisted ERC-20 addresses.
    function getWhitelistedTokens() external view returns (address[] memory) {
        return whitelistedTokens;
    }

    /// @notice Register a signed order for public discovery.
    function registerOrder(
        bytes32 orderHash,
        address taker,
        SpentItem[] calldata offer,
        ReceivedItem[] calldata consideration,
        string calldata orderURI
    ) external {
        for (uint256 i = 0; i < offer.length; i++) {
            if (offer[i].itemType == ItemType.ERC20) _checkWhitelist(offer[i].token);
        }
        for (uint256 i = 0; i < consideration.length; i++) {
            if (consideration[i].itemType == ItemType.ERC20) _checkWhitelist(consideration[i].token);
        }
        emit OrderRegistered(orderHash, msg.sender, taker, orderURI);
    }

    /// @notice Called by Seaport before token transfers. No pre-flight checks needed.
    function authorizeOrder(ZoneParameters calldata)
        external
        pure
        returns (bytes4)
    {
        return this.authorizeOrder.selector;
    }

    /// @notice Called by Seaport after token transfers. Validates taker + ERC-20 whitelist.
    function validateOrder(ZoneParameters calldata zoneParameters)
        external
        view
        returns (bytes4)
    {
        // Check taker restriction via zoneHash
        address allowedTaker = address(bytes20(zoneParameters.zoneHash));
        if (allowedTaker != address(0) && zoneParameters.fulfiller != allowedTaker) {
            revert Unauthorized();
        }

        // Check ERC-20 whitelist on offer items
        for (uint256 i = 0; i < zoneParameters.offer.length; i++) {
            if (zoneParameters.offer[i].itemType == ItemType.ERC20) {
                _checkWhitelist(zoneParameters.offer[i].token);
            }
        }

        // Check ERC-20 whitelist on consideration items
        for (uint256 i = 0; i < zoneParameters.consideration.length; i++) {
            if (zoneParameters.consideration[i].itemType == ItemType.ERC20) {
                _checkWhitelist(zoneParameters.consideration[i].token);
            }
        }

        return this.validateOrder.selector;
    }

    function getSeaportMetadata()
        external
        pure
        returns (string memory name, Schema[] memory schemas)
    {
        name = "OTCZone";
        schemas = new Schema[](0);
    }

    function supportsInterface(bytes4 interfaceId)
        external
        pure
        override
        returns (bool)
    {
        return interfaceId == type(ZoneInterface).interfaceId || interfaceId == 0x01ffc9a7; // ERC-165
    }

    function _checkWhitelist(address token) internal view {
        if (!whitelistedERC20[token]) revert TokenNotWhitelisted(token);
    }
}
