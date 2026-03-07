// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OTCZone} from "../src/OTCZone.sol";
import {ZoneParameters, SpentItem, ReceivedItem, Schema} from "seaport-types/lib/ConsiderationStructs.sol";
import {ItemType} from "seaport-types/lib/ConsiderationEnums.sol";
import {ZoneInterface} from "seaport-types/interfaces/ZoneInterface.sol";

contract OTCZoneTest is Test {
    OTCZone public zone;

    address public weth = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public usdc = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    address public fakeToken = address(0xDEAD);

    address public maker = address(0x1);
    address public taker = address(0x2);
    address public stranger = address(0x3);

    function setUp() public {
        address[] memory tokens = new address[](2);
        tokens[0] = weth;
        tokens[1] = usdc;
        zone = new OTCZone(tokens);
    }

    // ==================== Constructor ====================

    function test_constructor_whitelistsTokens() public view {
        assertTrue(zone.whitelistedERC20(weth));
        assertTrue(zone.whitelistedERC20(usdc));
        assertFalse(zone.whitelistedERC20(fakeToken));
    }

    function test_getWhitelistedTokens() public view {
        address[] memory tokens = zone.getWhitelistedTokens();
        assertEq(tokens.length, 2);
        assertEq(tokens[0], weth);
        assertEq(tokens[1], usdc);
    }

    function test_constructor_emptyWhitelist() public {
        address[] memory tokens = new address[](0);
        OTCZone emptyZone = new OTCZone(tokens);
        assertFalse(emptyZone.whitelistedERC20(weth));
    }

    // ==================== registerOrder ====================

    function test_registerOrder_nftOnly() public {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.prank(maker);
        vm.expectEmit(true, true, true, true);
        emit OTCZone.OrderRegistered(bytes32(uint256(1)), maker, taker, "ipfs://order");
        zone.registerOrder(bytes32(uint256(1)), taker, offer, consideration, "ipfs://order");
    }

    function test_registerOrder_withWhitelistedERC20() public {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC20, weth, 0, 1e18);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.prank(maker);
        zone.registerOrder(bytes32(uint256(2)), taker, offer, consideration, "data");
    }

    function test_registerOrder_revertsNonWhitelistedERC20_offer() public {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC20, fakeToken, 0, 1000);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(OTCZone.TokenNotWhitelisted.selector, fakeToken));
        zone.registerOrder(bytes32(uint256(3)), taker, offer, consideration, "data");
    }

    function test_registerOrder_revertsNonWhitelistedERC20_consideration() public {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC20, fakeToken, 0, 1000, payable(maker));

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(OTCZone.TokenNotWhitelisted.selector, fakeToken));
        zone.registerOrder(bytes32(uint256(4)), taker, offer, consideration, "data");
    }

    function test_registerOrder_mixedAssets() public {
        SpentItem[] memory offer = new SpentItem[](2);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);
        offer[1] = SpentItem(ItemType.ERC20, weth, 0, 1e18);

        ReceivedItem[] memory consideration = new ReceivedItem[](2);
        consideration[0] = ReceivedItem(ItemType.ERC1155, address(0xBBB), 5, 10, payable(maker));
        consideration[1] = ReceivedItem(ItemType.ERC20, usdc, 0, 2000e6, payable(maker));

        vm.prank(maker);
        zone.registerOrder(bytes32(uint256(5)), taker, offer, consideration, "data");
    }

    function test_registerOrder_makerIsMsgSender() public {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.prank(stranger);
        vm.expectEmit(true, true, true, true);
        emit OTCZone.OrderRegistered(bytes32(uint256(6)), stranger, taker, "data");
        zone.registerOrder(bytes32(uint256(6)), taker, offer, consideration, "data");
    }

    // ==================== authorizeOrder ====================

    function test_authorizeOrder_alwaysReturnsSelector() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));

        bytes4 result = zone.authorizeOrder(params);
        assertEq(result, zone.authorizeOrder.selector);
    }

    // ==================== validateOrder ====================

    function test_validateOrder_openOrder() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        params.fulfiller = stranger;

        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_restrictedTaker_authorized() public {
        bytes32 zoneHash = bytes32(bytes20(taker));
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = taker;

        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_restrictedTaker_unauthorized() public {
        bytes32 zoneHash = bytes32(bytes20(taker));
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = stranger;

        vm.expectRevert(OTCZone.Unauthorized.selector);
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsNonWhitelistedERC20_offer() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        params.offer = new SpentItem[](1);
        params.offer[0] = SpentItem(ItemType.ERC20, fakeToken, 0, 1000);

        vm.expectRevert(abi.encodeWithSelector(OTCZone.TokenNotWhitelisted.selector, fakeToken));
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsNonWhitelistedERC20_consideration() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        params.consideration = new ReceivedItem[](1);
        params.consideration[0] = ReceivedItem(ItemType.ERC20, fakeToken, 0, 1000, payable(maker));

        vm.expectRevert(abi.encodeWithSelector(OTCZone.TokenNotWhitelisted.selector, fakeToken));
        zone.validateOrder(params);
    }

    function test_validateOrder_whitelistedERC20_passes() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        params.offer = new SpentItem[](1);
        params.offer[0] = SpentItem(ItemType.ERC20, weth, 0, 1e18);
        params.consideration = new ReceivedItem[](1);
        params.consideration[0] = ReceivedItem(ItemType.ERC20, usdc, 0, 2000e6, payable(maker));

        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_emptyOfferAndConsideration() public {
        SpentItem[] memory offer = new SpentItem[](0);
        ReceivedItem[] memory consideration = new ReceivedItem[](0);
        bytes32[] memory orderHashes = new bytes32[](0);

        ZoneParameters memory params = ZoneParameters({
            orderHash: bytes32(uint256(1)),
            fulfiller: taker,
            offerer: maker,
            offer: offer,
            consideration: consideration,
            extraData: "",
            orderHashes: orderHashes,
            startTime: block.timestamp,
            endTime: block.timestamp + 30 days,
            zoneHash: bytes32(0)
        });

        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    // ==================== ERC-165 ====================

    function test_supportsInterface_zoneInterface() public view {
        assertTrue(zone.supportsInterface(type(ZoneInterface).interfaceId));
    }

    function test_supportsInterface_erc165() public view {
        assertTrue(zone.supportsInterface(0x01ffc9a7));
    }

    function test_supportsInterface_random() public view {
        assertFalse(zone.supportsInterface(0xdeadbeef));
    }

    // ==================== getSeaportMetadata ====================

    function test_getSeaportMetadata() public view {
        (string memory name, Schema[] memory schemas) = zone.getSeaportMetadata();
        assertEq(name, "OTCZone");
        assertEq(schemas.length, 0);
    }

    // ==================== Helpers ====================

    function _zoneParams(bytes32 zoneHash) internal view returns (ZoneParameters memory) {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        bytes32[] memory orderHashes = new bytes32[](0);

        return ZoneParameters({
            orderHash: bytes32(uint256(1)),
            fulfiller: taker,
            offerer: maker,
            offer: offer,
            consideration: consideration,
            extraData: "",
            orderHashes: orderHashes,
            startTime: block.timestamp,
            endTime: block.timestamp + 30 days,
            zoneHash: zoneHash
        });
    }
}
