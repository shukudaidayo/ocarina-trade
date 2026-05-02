// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OTCRegistry, OrderRegistration} from "../src/OTCRegistry.sol";
import {
    ZoneParameters,
    SpentItem,
    ReceivedItem,
    Schema,
    OrderComponents,
    Order,
    OfferItem,
    ConsiderationItem
} from "seaport-types/lib/ConsiderationStructs.sol";
import {ItemType, OrderType} from "seaport-types/lib/ConsiderationEnums.sol";
import {ZoneInterface} from "seaport-types/interfaces/ZoneInterface.sol";

/// @dev Minimal Seaport mock. Returns keccak256(abi.encode(order)) as the hash
/// so tests can compute the expected hash locally without reimplementing Seaport's
/// full EIP-712 derivation. validate() accepts all signatures by default; set
/// shouldRejectValidate = true to simulate an invalid Seaport signature.
contract MockSeaport {
    bool public shouldRejectValidate;
    bool public shouldReturnFalseValidate;
    mapping(address => uint256) public counters;

    function setRejectValidate(bool reject) external {
        shouldRejectValidate = reject;
    }

    function setReturnFalseValidate(bool returnFalse) external {
        shouldReturnFalseValidate = returnFalse;
    }

    function setCounter(address offerer, uint256 counter) external {
        counters[offerer] = counter;
    }

    function getOrderHash(OrderComponents calldata order) external pure returns (bytes32) {
        return keccak256(abi.encode(order));
    }

    function getCounter(address offerer) external view returns (uint256) {
        return counters[offerer];
    }

    function validate(Order[] calldata) external view returns (bool) {
        require(!shouldRejectValidate, "invalid seaport sig");
        if (shouldReturnFalseValidate) return false;
        return true;
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

contract MockERC20 {}

contract MockERC165Token {
    bytes4 private immutable supportedInterface;

    constructor(bytes4 _supportedInterface) {
        supportedInterface = _supportedInterface;
    }

    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        return interfaceId == supportedInterface || interfaceId == 0x01ffc9a7;
    }
}

contract OTCRegistryTest is Test {
    OTCRegistry public zone;
    MockSeaport public mockSeaport;
    address public seaport;

    address public weth = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public usdc = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    address public fakeToken = address(0xDEAD);
    address public fakeERC20;
    address public erc721;
    address public erc1155;

    uint256 public makerPk = 0xA11CE;
    address public maker;
    address public taker = address(0x2);
    address public stranger = address(0x3);

    // Dummy Seaport signature — real sig verified by Seaport at fulfillment, not here.
    bytes internal constant SEAPORT_SIG = hex"deadbeefdeadbeef";

    bytes32 internal constant REGISTRATION_TYPEHASH =
        keccak256("OrderRegistration(bytes32 orderHash,bytes seaportSignature,string memo)");

    uint256 internal constant DEFAULT_END_TIME = 1e18;

    function setUp() public {
        maker = vm.addr(makerPk);
        mockSeaport = new MockSeaport();
        seaport = address(mockSeaport);
        fakeERC20 = address(new MockERC20());
        erc721 = address(new MockERC165Token(0x80ac58cd));
        erc1155 = address(new MockERC165Token(0xd9b67a26));

        address[] memory tokens = new address[](2);
        tokens[0] = weth;
        tokens[1] = usdc;
        zone = new OTCRegistry(tokens, seaport);
    }

    // ==================== Helpers ====================

    function _buildComponents(address _maker, address _taker, uint256 endTime)
        internal
        view
        returns (OrderComponents memory)
    {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem({
            itemType: ItemType.ERC721, token: erc721, identifierOrCriteria: 1, startAmount: 1, endAmount: 1
        });

        ConsiderationItem[] memory consideration = new ConsiderationItem[](1);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC721,
            token: erc721,
            identifierOrCriteria: 2,
            startAmount: 1,
            endAmount: 1,
            recipient: payable(_maker)
        });

        bytes32 zoneHash = _taker != address(0) ? bytes32(uint256(uint160(_taker))) : bytes32(0);

        return OrderComponents({
            offerer: _maker,
            zone: address(zone),
            offer: offer,
            consideration: consideration,
            orderType: OrderType.FULL_RESTRICTED,
            startTime: 0,
            endTime: endTime,
            zoneHash: zoneHash,
            salt: 12345,
            conduitKey: bytes32(0),
            counter: 0
        });
    }

    function _orderHash(OrderComponents memory components) internal view returns (bytes32) {
        return mockSeaport.getOrderHash(components);
    }

    function _digest(bytes32 orderHash, bytes memory seaportSig, string memory memo) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(REGISTRATION_TYPEHASH, orderHash, keccak256(seaportSig), keccak256(bytes(memo))));
        return keccak256(abi.encodePacked(bytes2(0x1901), zone.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 pk, bytes32 orderHash, bytes memory seaportSig, string memory memo)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(orderHash, seaportSig, memo));
        return abi.encodePacked(r, s, v);
    }

    function _buildComponentsWithERC20(address _maker, address _taker, address offerToken, address considerToken)
        internal
        view
        returns (OrderComponents memory)
    {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem({
            itemType: ItemType.ERC20, token: offerToken, identifierOrCriteria: 0, startAmount: 1e18, endAmount: 1e18
        });

        ConsiderationItem[] memory consideration = new ConsiderationItem[](1);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: considerToken,
            identifierOrCriteria: 0,
            startAmount: 2000e6,
            endAmount: 2000e6,
            recipient: payable(_maker)
        });

        bytes32 zoneHash = _taker != address(0) ? bytes32(uint256(uint160(_taker))) : bytes32(0);

        return OrderComponents({
            offerer: _maker,
            zone: address(zone),
            offer: offer,
            consideration: consideration,
            orderType: OrderType.FULL_RESTRICTED,
            startTime: 0,
            endTime: DEFAULT_END_TIME,
            zoneHash: zoneHash,
            salt: 12345,
            conduitKey: bytes32(0),
            counter: 0
        });
    }

    function _signedReg(address _taker, string memory memo) internal view returns (OrderRegistration memory) {
        OrderComponents memory components = _buildComponents(maker, _taker, DEFAULT_END_TIME);
        bytes32 orderHash = _orderHash(components);
        return OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, memo),
            memo: memo
        });
    }

    function _zoneParams(bytes32 zoneHash) internal view returns (ZoneParameters memory) {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, erc721, 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, erc721, 2, 1, payable(maker));

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

    function _registeredZoneParams(address _taker) internal returns (ZoneParameters memory) {
        OrderRegistration memory reg = _signedReg(_taker, "");
        bytes32 orderHash = _orderHash(reg.components);
        zone.registerOrder(reg);

        ZoneParameters memory params = _zoneParams(reg.components.zoneHash);
        params.orderHash = orderHash;
        params.offerer = reg.components.offerer;
        return params;
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
        OTCRegistry emptyZone = new OTCRegistry(tokens, seaport);
        assertFalse(emptyZone.whitelistedERC20(weth));
    }

    function test_constructor_storesSeaport() public view {
        assertEq(zone.seaport(), seaport);
    }

    // ==================== Domain separator ====================

    function test_domainSeparator_matchesEIP712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OTCRegistry"),
                keccak256("1"),
                block.chainid,
                address(zone)
            )
        );
        assertEq(zone.DOMAIN_SEPARATOR(), expected);
    }

    function test_domainSeparator_rebuildsOnForkedChain() public {
        bytes32 original = zone.DOMAIN_SEPARATOR();
        vm.chainId(block.chainid + 1);
        bytes32 updated = zone.DOMAIN_SEPARATOR();
        assertTrue(original != updated);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("OTCRegistry"),
                keccak256("1"),
                block.chainid,
                address(zone)
            )
        );
        assertEq(updated, expected);
    }

    // ==================== registerOrder ====================

    function test_registerOrder_restrictedTaker() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        bytes32 orderHash = _orderHash(reg.components);

        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, SEAPORT_SIG, "");
        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash, maker));
    }

    function test_registerOrder_openOffer() public {
        OrderRegistration memory reg = _signedReg(address(0), "");
        bytes32 orderHash = _orderHash(reg.components);

        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, address(0), reg.components, SEAPORT_SIG, "");
        zone.registerOrder(reg);
    }

    function test_registerOrder_anyoneCanSubmitTx() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        bytes32 orderHash = _orderHash(reg.components);

        vm.prank(stranger);
        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, SEAPORT_SIG, "");
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsInvalidSignature() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(0xB0B, _orderHash(components), SEAPORT_SIG, ""), // stranger's key
            memo: ""
        });

        vm.expectRevert(OTCRegistry.InvalidSignature.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsBadSignatureLength() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        OrderRegistration memory reg = OrderRegistration({
            components: components, seaportSignature: SEAPORT_SIG, signature: new bytes(63), memo: ""
        });

        vm.expectRevert(OTCRegistry.InvalidSignature.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_compactSignature() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        bytes32 orderHash = _orderHash(components);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, _digest(orderHash, SEAPORT_SIG, ""));

        bytes32 yParityAndS = s;
        if (v == 28) yParityAndS = bytes32(uint256(s) | (1 << 255));

        OrderRegistration memory reg = OrderRegistration({
            components: components, seaportSignature: SEAPORT_SIG, signature: abi.encodePacked(r, yParityAndS), memo: ""
        });
        assertEq(reg.signature.length, 64);
        zone.registerOrder(reg);
    }

    function test_registerOrder_contractWallet() public {
        MockContractWallet wallet = new MockContractWallet(maker);
        OrderComponents memory components = _buildComponents(address(wallet), taker, DEFAULT_END_TIME);
        bytes32 orderHash = _orderHash(components);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, _digest(orderHash, SEAPORT_SIG, ""));

        OrderRegistration memory reg = OrderRegistration({
            components: components, seaportSignature: SEAPORT_SIG, signature: abi.encode(v, r, s), memo: ""
        });
        zone.registerOrder(reg);
    }

    // ==================== Zone / orderType validation ====================

    function test_registerOrder_revertsWrongZone() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.zone = address(0xDEAD);

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});
        vm.expectRevert(OTCRegistry.WrongZone.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsWrongOrderType() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.orderType = OrderType.FULL_OPEN;

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});
        vm.expectRevert(OTCRegistry.WrongOrderType.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsNonzeroConduitKey() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.conduitKey = bytes32(uint256(1));

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});
        vm.expectRevert(OTCRegistry.InvalidConduitKey.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsStaleCounter() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.counter = 1;

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidCounter.selector, 1, 0));
        zone.registerOrder(reg);
    }

    function test_registerOrder_currentNonzeroCounterPasses() public {
        mockSeaport.setCounter(maker, 2);
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.counter = 2;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, SEAPORT_SIG, "");
        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash, maker));
    }

    function test_registerOrder_revertsConsiderationRecipientNotMaker() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.consideration[0].recipient = payable(stranger);

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidRecipient.selector, stranger));
        zone.registerOrder(reg);
    }

    // ==================== Replay guard ====================

    function test_registerOrder_revertsDuplicateRegistration() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        zone.registerOrder(reg);

        vm.expectRevert(OTCRegistry.AlreadyRegistered.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_duplicateBlockedRegardlessOfSender() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        zone.registerOrder(reg);

        vm.prank(stranger);
        vm.expectRevert(OTCRegistry.AlreadyRegistered.selector);
        zone.registerOrder(reg);
    }

    /// @dev Dedup is keyed on (orderHash, maker) so a squatter cannot brick a
    /// victim's orderHash with a front-run registration.
    function test_registerOrder_differentMakersCanShareOrderHash() public {
        uint256 attackerPk = 0xDEADBEEF;
        address attacker = vm.addr(attackerPk);

        // Attacker registers under their own maker slot
        OrderComponents memory attackerComponents = _buildComponents(attacker, taker, DEFAULT_END_TIME);
        bytes32 attackerHash = _orderHash(attackerComponents);
        OrderRegistration memory attackerReg = OrderRegistration({
            components: attackerComponents,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(attackerPk, attackerHash, SEAPORT_SIG, ""),
            memo: ""
        });
        zone.registerOrder(attackerReg);
        assertTrue(zone.registered(attackerHash, attacker));

        // Victim (maker) can still register their own components
        OrderRegistration memory victimReg = _signedReg(taker, "");
        bytes32 victimHash = _orderHash(victimReg.components);
        zone.registerOrder(victimReg);
        assertTrue(zone.registered(victimHash, maker));
    }

    // ==================== Tamper resistance ====================

    function test_registerOrder_revertsTamperedComponents() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        // Change a field in components — different hash, sig fails
        reg.components.salt = 99999;

        vm.expectRevert(OTCRegistry.InvalidSignature.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsTamperedSeaportSignature() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        reg.seaportSignature = hex"badbad";

        vm.expectRevert(OTCRegistry.InvalidSignature.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsTamperedMemo() public {
        OrderRegistration memory reg = _signedReg(taker, "real memo");
        reg.memo = "evil memo";

        vm.expectRevert(OTCRegistry.InvalidSignature.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsInvalidSeaportSignature() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        mockSeaport.setRejectValidate(true);

        vm.expectRevert();
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsSeaportValidationFalse() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        mockSeaport.setReturnFalseValidate(true);

        vm.expectRevert(OTCRegistry.SeaportValidationFailed.selector);
        zone.registerOrder(reg);
    }

    // ==================== Deadline (endTime) ====================

    function test_registerOrder_revertsExpiredOrder() public {
        vm.warp(1_000_000);
        OrderComponents memory components = _buildComponents(maker, taker, block.timestamp - 1);
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(OTCRegistry.Expired.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsStartTimeAfterEndTime() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.startTime = DEFAULT_END_TIME;
        components.endTime = DEFAULT_END_TIME - 1;
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.InvalidTime.selector, DEFAULT_END_TIME, DEFAULT_END_TIME - 1)
        );
        zone.registerOrder(reg);
    }

    function test_registerOrder_acceptsAtExactEndTime() public {
        OrderComponents memory components = _buildComponents(maker, taker, block.timestamp);
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash, maker));
    }

    /// @dev An expired order must revert without consuming the (orderHash, maker)
    /// slot. The maker can create a new order (fresh endTime = new hash) and publish.
    function test_registerOrder_expiredOrderDoesNotConsumeSlot() public {
        vm.warp(1_000_000);

        OrderComponents memory expired = _buildComponents(maker, taker, block.timestamp - 1);
        bytes32 expiredHash = _orderHash(expired);
        OrderRegistration memory expiredReg = OrderRegistration({
            components: expired,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, expiredHash, SEAPORT_SIG, ""),
            memo: ""
        });
        vm.expectRevert(OTCRegistry.Expired.selector);
        zone.registerOrder(expiredReg);
        assertFalse(zone.registered(expiredHash, maker));

        // A fresh order (different endTime → different hash) can be registered.
        OrderComponents memory fresh = _buildComponents(maker, taker, block.timestamp + 1 days);
        bytes32 freshHash = _orderHash(fresh);
        OrderRegistration memory freshReg = OrderRegistration({
            components: fresh,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, freshHash, SEAPORT_SIG, ""),
            memo: ""
        });
        zone.registerOrder(freshReg);
        assertTrue(zone.registered(freshHash, maker));
    }

    // ==================== Memo ====================

    function test_registerOrder_withMemo() public {
        OrderRegistration memory reg = _signedReg(taker, "Looking for any Azuki");
        bytes32 orderHash = _orderHash(reg.components);

        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, SEAPORT_SIG, "Looking for any Azuki");
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsMemoTooLong() public {
        bytes memory longMemo = new bytes(281);
        for (uint256 i = 0; i < 281; i++) {
            longMemo[i] = "a";
        }

        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        OrderRegistration memory reg = OrderRegistration({
            components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: string(longMemo)
        });

        vm.expectRevert(OTCRegistry.MemoTooLong.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_maxLengthMemo() public {
        bytes memory maxMemo = new bytes(280);
        for (uint256 i = 0; i < 280; i++) {
            maxMemo[i] = "a";
        }

        OrderRegistration memory reg = _signedReg(taker, string(maxMemo));
        zone.registerOrder(reg);
    }

    // ==================== ERC-20 whitelist at registration ====================

    function test_registerOrder_revertsNonWhitelistedERC20_offer() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, fakeToken, usdc);
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.TokenNotWhitelisted.selector, fakeToken));
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsNonWhitelistedERC20_consideration() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, weth, fakeToken);
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.TokenNotWhitelisted.selector, fakeToken));
        zone.registerOrder(reg);
    }

    function test_registerOrder_whitelistedERC20_passes() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, weth, usdc);
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash, maker));
    }

    function test_registerOrder_revertsNativeOfferItem() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer[0] = OfferItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: 1 ether,
            endAmount: 1 ether
        });
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(OTCRegistry.InvalidNativeOfferItem.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_nativeConsiderationPasses() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.consideration[0] = ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: 1 ether,
            endAmount: 1 ether,
            recipient: payable(maker)
        });
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash, maker));
    }

    function test_registerOrder_revertsZeroERC20Amount() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, weth, usdc);
        components.offer[0].startAmount = 0;
        components.offer[0].endAmount = 0;
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(OTCRegistry.MissingItemAmount.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsZeroERC1155Amount() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer[0].itemType = ItemType.ERC1155;
        components.offer[0].token = erc1155;
        components.offer[0].startAmount = 0;
        components.offer[0].endAmount = 0;
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(OTCRegistry.MissingItemAmount.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsZeroNativeConsiderationAmount() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.consideration[0] = ConsiderationItem({
            itemType: ItemType.NATIVE,
            token: address(0),
            identifierOrCriteria: 0,
            startAmount: 0,
            endAmount: 0,
            recipient: payable(maker)
        });
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(OTCRegistry.MissingItemAmount.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsVariableAmount_offer() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, weth, usdc);
        components.offer[0].endAmount = components.offer[0].startAmount + 1;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                OTCRegistry.VariableAmount.selector, components.offer[0].startAmount, components.offer[0].endAmount
            )
        );
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsVariableAmount_consideration() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, weth, usdc);
        components.consideration[0].endAmount = components.consideration[0].startAmount + 1;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                OTCRegistry.VariableAmount.selector,
                components.consideration[0].startAmount,
                components.consideration[0].endAmount
            )
        );
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsVariableAmount_erc1155() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer[0].itemType = ItemType.ERC1155;
        components.offer[0].token = erc1155;
        components.offer[0].startAmount = 3;
        components.offer[0].endAmount = 4;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.VariableAmount.selector, 3, 4));
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsERC20MasqueradingAsERC721_offer() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer[0].token = fakeERC20;
        components.offer[0].identifierOrCriteria = 1e18;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.InvalidTokenStandard.selector, fakeERC20, bytes4(0x80ac58cd))
        );
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsERC20MasqueradingAsERC721_consideration() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.consideration[0].token = fakeERC20;
        components.consideration[0].identifierOrCriteria = 2000e6;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.InvalidTokenStandard.selector, fakeERC20, bytes4(0x80ac58cd))
        );
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsERC20WithIdentifier() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, weth, usdc);
        components.offer[0].identifierOrCriteria = 1;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(OTCRegistry.InvalidERC20Identifier.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsERC721AmountNotOne() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer[0].startAmount = 2;
        components.offer[0].endAmount = 2;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidERC721Amount.selector, 2));
        zone.registerOrder(reg);
    }

    function test_registerOrder_erc1155PassesERC165Check() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer[0].itemType = ItemType.ERC1155;
        components.offer[0].token = erc1155;
        components.offer[0].startAmount = 3;
        components.offer[0].endAmount = 3;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash, maker));
    }

    // ==================== authorizeOrder ====================

    function test_authorizeOrder_requiresSeaportCaller() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        vm.expectRevert(OTCRegistry.Unauthorized.selector);
        zone.authorizeOrder(params);
    }

    function test_authorizeOrder_openOrder() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        params.fulfiller = stranger;

        vm.prank(seaport);
        bytes4 result = zone.authorizeOrder(params);
        assertEq(result, zone.authorizeOrder.selector);
    }

    function test_authorizeOrder_restrictedTaker_authorized() public {
        bytes32 zoneHash = bytes32(uint256(uint160(taker)));
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = taker;

        vm.prank(seaport);
        bytes4 result = zone.authorizeOrder(params);
        assertEq(result, zone.authorizeOrder.selector);
    }

    function test_authorizeOrder_restrictedTaker_unauthorized() public {
        bytes32 zoneHash = bytes32(uint256(uint160(taker)));
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = stranger;

        vm.prank(seaport);
        vm.expectRevert(OTCRegistry.Unauthorized.selector);
        zone.authorizeOrder(params);
    }

    /// @dev Upper 96 bits of zoneHash are reserved (SPEC §3.1) — authorizeOrder
    /// must ignore them so Seaport's existing convention still works.
    function test_authorizeOrder_ignoresUpperZoneHashBits() public {
        uint256 reserved = (uint256(0xDEADBEEF) << 160);
        bytes32 zoneHash = bytes32(reserved | uint256(uint160(taker)));
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = taker;

        vm.prank(seaport);
        bytes4 result = zone.authorizeOrder(params);
        assertEq(result, zone.authorizeOrder.selector);
    }

    // ==================== validateOrder ====================

    function test_validateOrder_requiresSeaportCaller() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        vm.expectRevert(OTCRegistry.Unauthorized.selector);
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsUnregisteredOrder() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));

        vm.prank(seaport);
        vm.expectRevert(OTCRegistry.OrderNotRegistered.selector);
        zone.validateOrder(params);
    }

    function test_validateOrder_registeredOrderPasses() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        params.fulfiller = stranger;

        vm.prank(seaport);
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_revertsNonWhitelistedERC20_offer() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        params.offer = new SpentItem[](1);
        params.offer[0] = SpentItem(ItemType.ERC20, fakeToken, 0, 1000);

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.TokenNotWhitelisted.selector, fakeToken));
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsNonWhitelistedERC20_consideration() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        params.consideration = new ReceivedItem[](1);
        params.consideration[0] = ReceivedItem(ItemType.ERC20, fakeToken, 0, 1000, payable(maker));

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.TokenNotWhitelisted.selector, fakeToken));
        zone.validateOrder(params);
    }

    function test_validateOrder_whitelistedERC20_passes() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        params.offer = new SpentItem[](1);
        params.offer[0] = SpentItem(ItemType.ERC20, weth, 0, 1e18);
        params.consideration = new ReceivedItem[](1);
        params.consideration[0] = ReceivedItem(ItemType.ERC20, usdc, 0, 2000e6, payable(maker));

        vm.prank(seaport);
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_doesNotRecheckNonERC20ItemShape() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        params.offer[0] = SpentItem(ItemType.ERC721, erc721, 1, 2);
        params.consideration[0].recipient = payable(stranger);

        vm.prank(seaport);
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_emptyOfferAndConsideration() public {
        ZoneParameters memory registered = _registeredZoneParams(address(0));
        SpentItem[] memory offer = new SpentItem[](0);
        ReceivedItem[] memory consideration = new ReceivedItem[](0);
        bytes32[] memory orderHashes = new bytes32[](0);

        ZoneParameters memory params = ZoneParameters({
            orderHash: registered.orderHash,
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

        vm.prank(seaport);
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
        assertEq(name, "OTCRegistry");
        assertEq(schemas.length, 0);
    }
}
