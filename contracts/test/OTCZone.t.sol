// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OTCZone} from "../src/OTCZone.sol";
import {ZoneParameters, SpentItem, ReceivedItem, Schema} from "seaport-types/lib/ConsiderationStructs.sol";
import {ItemType} from "seaport-types/lib/ConsiderationEnums.sol";
import {ZoneInterface} from "seaport-types/interfaces/ZoneInterface.sol";

/// @dev Mock Seaport that returns a known domain separator.
contract MockSeaport {
    bytes32 public constant DOMAIN_SEPARATOR = keccak256("MockSeaportDomain");

    function information() external pure returns (string memory, bytes32, address) {
        return ("1.6", DOMAIN_SEPARATOR, address(0));
    }
}

/// @dev Mock EIP-1271 contract wallet that validates signatures from a single owner.
contract MockContractWallet {
    address public owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = abi.decode(signature, (uint8, bytes32, bytes32));
        address recovered = ecrecover(hash, v, r, s);
        if (recovered == owner) return 0x1626ba7e; // EIP-1271 magic value
        return 0xffffffff;
    }
}

contract OTCZoneTest is Test {
    OTCZone public zone;
    MockSeaport public mockSeaport;

    address public weth = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public usdc = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    address public fakeToken = address(0xDEAD);

    uint256 public makerPk = 0xA11CE;
    address public maker;
    address public taker = address(0x2);
    address public stranger = address(0x3);

    function setUp() public {
        maker = vm.addr(makerPk);

        mockSeaport = new MockSeaport();

        address[] memory tokens = new address[](2);
        tokens[0] = weth;
        tokens[1] = usdc;
        zone = new OTCZone(tokens, address(mockSeaport));
    }

    // ==================== Helpers ====================

    function _sign(uint256 pk, bytes32 orderHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), mockSeaport.DOMAIN_SEPARATOR(), orderHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

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
        OTCZone emptyZone = new OTCZone(tokens, address(mockSeaport));
        assertFalse(emptyZone.whitelistedERC20(weth));
    }

    function test_constructor_storesSeaport() public view {
        assertEq(zone.seaport(), address(mockSeaport));
    }

    // ==================== registerOrder ====================

    function test_registerOrder_nftOnly() public {
        bytes32 orderHash = bytes32(uint256(1));
        bytes memory sig = _sign(makerPk, orderHash);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.expectEmit(true, true, true, true);
        emit OTCZone.OrderRegistered(orderHash, maker, taker, "ipfs://order");
        zone.registerOrder(orderHash, maker, taker, offer, consideration, sig, "ipfs://order");
    }

    function test_registerOrder_withWhitelistedERC20() public {
        bytes32 orderHash = bytes32(uint256(2));
        bytes memory sig = _sign(makerPk, orderHash);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC20, weth, 0, 1e18);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        zone.registerOrder(orderHash, maker, taker, offer, consideration, sig, "data");
    }

    function test_registerOrder_revertsNonWhitelistedERC20_offer() public {
        bytes32 orderHash = bytes32(uint256(3));
        bytes memory sig = _sign(makerPk, orderHash);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC20, fakeToken, 0, 1000);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.expectRevert(abi.encodeWithSelector(OTCZone.TokenNotWhitelisted.selector, fakeToken));
        zone.registerOrder(orderHash, maker, taker, offer, consideration, sig, "data");
    }

    function test_registerOrder_revertsNonWhitelistedERC20_consideration() public {
        bytes32 orderHash = bytes32(uint256(4));
        bytes memory sig = _sign(makerPk, orderHash);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC20, fakeToken, 0, 1000, payable(maker));

        vm.expectRevert(abi.encodeWithSelector(OTCZone.TokenNotWhitelisted.selector, fakeToken));
        zone.registerOrder(orderHash, maker, taker, offer, consideration, sig, "data");
    }

    function test_registerOrder_mixedAssets() public {
        bytes32 orderHash = bytes32(uint256(5));
        bytes memory sig = _sign(makerPk, orderHash);

        SpentItem[] memory offer = new SpentItem[](2);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);
        offer[1] = SpentItem(ItemType.ERC20, weth, 0, 1e18);

        ReceivedItem[] memory consideration = new ReceivedItem[](2);
        consideration[0] = ReceivedItem(ItemType.ERC1155, address(0xBBB), 5, 10, payable(maker));
        consideration[1] = ReceivedItem(ItemType.ERC20, usdc, 0, 2000e6, payable(maker));

        zone.registerOrder(orderHash, maker, taker, offer, consideration, sig, "data");
    }

    function test_registerOrder_anyoneCanSubmitTx() public {
        bytes32 orderHash = bytes32(uint256(6));
        bytes memory sig = _sign(makerPk, orderHash);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        // Stranger submits the tx, but maker is still the verified signer
        vm.prank(stranger);
        vm.expectEmit(true, true, true, true);
        emit OTCZone.OrderRegistered(orderHash, maker, taker, "data");
        zone.registerOrder(orderHash, maker, taker, offer, consideration, sig, "data");
    }

    function test_registerOrder_revertsInvalidSignature() public {
        bytes32 orderHash = bytes32(uint256(7));
        // Sign with stranger's key, but claim maker
        uint256 strangerPk = 0xB0B;
        bytes memory sig = _sign(strangerPk, orderHash);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.expectRevert(OTCZone.InvalidSignature.selector);
        zone.registerOrder(orderHash, maker, taker, offer, consideration, sig, "data");
    }

    function test_registerOrder_revertsBadSignatureLength() public {
        bytes32 orderHash = bytes32(uint256(8));
        bytes memory badSig = new bytes(63); // wrong length

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        vm.expectRevert(OTCZone.InvalidSignature.selector);
        zone.registerOrder(orderHash, maker, taker, offer, consideration, badSig, "data");
    }

    function test_registerOrder_compactSignature() public {
        // Solady supports EIP-2098 compact (64-byte) signatures
        bytes32 orderHash = bytes32(uint256(9));
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), mockSeaport.DOMAIN_SEPARATOR(), orderHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, digest);

        bytes32 yParityAndS = s;
        if (v == 28) {
            yParityAndS = bytes32(uint256(s) | (1 << 255));
        }
        bytes memory compactSig = abi.encodePacked(r, yParityAndS);
        assertEq(compactSig.length, 64);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(maker));

        zone.registerOrder(orderHash, maker, taker, offer, consideration, compactSig, "data");
    }

    function test_registerOrder_contractWallet() public {
        // Deploy a mock contract wallet owned by maker's EOA
        MockContractWallet wallet = new MockContractWallet(maker);

        bytes32 orderHash = bytes32(uint256(10));
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), mockSeaport.DOMAIN_SEPARATOR(), orderHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, digest);
        bytes memory sig = abi.encode(v, r, s);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, address(0xAAA), 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, address(0xBBB), 2, 1, payable(address(wallet)));

        // Register with the contract wallet as maker
        zone.registerOrder(orderHash, address(wallet), taker, offer, consideration, sig, "data");
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
}
