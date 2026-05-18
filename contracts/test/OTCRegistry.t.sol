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

contract MockPermissiveERC165Token {
    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
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
    uint256 public takerPk = 0xB0B;
    address public maker;
    address public taker;
    address public stranger = address(0x3);

    // Dummy Seaport signature — real sig verified by Seaport at fulfillment, not here.
    bytes internal constant SEAPORT_SIG = hex"deadbeefdeadbeef";

    bytes32 internal constant REGISTRATION_TYPEHASH =
        keccak256("OrderRegistration(bytes32 orderHash,bytes seaportSignature,string memo)");
    bytes32 internal constant TIP_ITEM_TYPEHASH =
        keccak256("TipItem(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)");
    bytes32 internal constant TIP_AUTHORIZATION_TYPEHASH =
        keccak256("TipAuthorization(bytes32 orderHash,address fulfiller,bytes32 tipsHash,uint256 deadline)");

    uint256 internal constant DEFAULT_END_TIME = 1e18;
    uint256 internal constant ZONE_HASH_VERSION = 1;

    function setUp() public {
        maker = vm.addr(makerPk);
        taker = vm.addr(takerPk);
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

        bytes32 zoneHash = _encodeZoneHash(_taker, consideration.length);

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

    function _encodeZoneHash(address _taker, uint256 originalConsiderationCount) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_taker)) | (originalConsiderationCount << 160) | (ZONE_HASH_VERSION << 192));
    }

    function _sign(uint256 pk, bytes32 orderHash, bytes memory seaportSig, string memory memo)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(orderHash, seaportSig, memo));
        return abi.encodePacked(r, s, v);
    }

    function _tipDigest(bytes32 orderHash, address fulfiller, bytes32 tipsHash, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(TIP_AUTHORIZATION_TYPEHASH, orderHash, fulfiller, tipsHash, deadline));
        return keccak256(abi.encodePacked(bytes2(0x1901), zone.DOMAIN_SEPARATOR(), structHash));
    }

    function _signTip(uint256 pk, bytes32 orderHash, address fulfiller, ReceivedItem[] memory tips, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _tipDigest(orderHash, fulfiller, _tipsHash(tips), deadline));
        return abi.encodePacked(r, s, v);
    }

    function _tipsHash(ReceivedItem[] memory tips) internal pure returns (bytes32) {
        bytes32[] memory tipHashes = new bytes32[](tips.length);
        for (uint256 i = 0; i < tips.length; ++i) {
            tipHashes[i] = keccak256(
                abi.encode(
                    TIP_ITEM_TYPEHASH,
                    tips[i].itemType,
                    tips[i].token,
                    tips[i].identifier,
                    tips[i].amount,
                    tips[i].recipient
                )
            );
        }
        return keccak256(abi.encodePacked(tipHashes));
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

        bytes32 zoneHash = _encodeZoneHash(_taker, consideration.length);

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

    function _signedRegFromComponents(OrderComponents memory components, string memory memo)
        internal
        view
        returns (OrderRegistration memory)
    {
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

    function _appendSingleTip(ZoneParameters memory params, ReceivedItem memory tip)
        internal
        pure
        returns (ZoneParameters memory, ReceivedItem[] memory)
    {
        ReceivedItem[] memory tips = new ReceivedItem[](1);
        tips[0] = tip;

        ReceivedItem[] memory consideration = new ReceivedItem[](params.consideration.length + 1);
        for (uint256 i = 0; i < params.consideration.length; ++i) {
            consideration[i] = params.consideration[i];
        }
        consideration[params.consideration.length] = tip;
        params.consideration = consideration;
        return (params, tips);
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

    function test_constructor_revertsZeroSeaport() public {
        address[] memory tokens = new address[](1);
        tokens[0] = weth;

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidSeaport.selector, address(0)));
        new OTCRegistry(tokens, address(0));
    }

    function test_constructor_revertsNonContractSeaport() public {
        address[] memory tokens = new address[](1);
        tokens[0] = weth;

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidSeaport.selector, address(0x1234)));
        new OTCRegistry(tokens, address(0x1234));
    }

    function test_constructor_revertsZeroWhitelistToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = weth;
        tokens[1] = address(0);

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidWhitelistToken.selector, address(0)));
        new OTCRegistry(tokens, seaport);
    }

    function test_constructor_revertsDuplicateWhitelistToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = weth;
        tokens[1] = weth;

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.DuplicateWhitelistToken.selector, weth));
        new OTCRegistry(tokens, seaport);
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
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, "");
        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash));
    }

    function test_registerOrder_openOffer() public {
        OrderRegistration memory reg = _signedReg(address(0), "");
        bytes32 orderHash = _orderHash(reg.components);

        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, address(0), reg.components, "");
        zone.registerOrder(reg);
    }

    function test_registerOrder_anyoneCanSubmitTx() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        bytes32 orderHash = _orderHash(reg.components);

        vm.prank(stranger);
        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, "");
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
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.WrongZone.selector, address(0xDEAD), address(zone)));
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsWrongOrderType() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.orderType = OrderType.FULL_OPEN;

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});
        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.WrongOrderType.selector, OrderType.FULL_OPEN, OrderType.FULL_RESTRICTED)
        );
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsNonzeroConduitKey() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.conduitKey = bytes32(uint256(1));

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidConduitKey.selector, bytes32(uint256(1))));
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsEmptyOffer() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer = new OfferItem[](0);

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(OTCRegistry.EmptyOffer.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsEmptyConsideration() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.consideration = new ConsiderationItem[](0);

        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(OTCRegistry.EmptyConsideration.selector);
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsInvalidZoneHashVersion() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.zoneHash = bytes32((uint256(1) << 160) | uint256(uint160(taker)));
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidZoneHash.selector, components.zoneHash));
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsReservedZoneHashBits() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.zoneHash = bytes32(uint256(1) << 200 | uint256(components.zoneHash));
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidZoneHash.selector, components.zoneHash));
        zone.registerOrder(reg);
    }

    function test_registerOrder_revertsMismatchedZoneHashConsiderationCount() public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.zoneHash = _encodeZoneHash(taker, 2);
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidZoneHash.selector, components.zoneHash));
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
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, "");
        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash));
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
        bytes32 orderHash = _orderHash(reg.components);
        zone.registerOrder(reg);

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.AlreadyRegistered.selector, orderHash, maker));
        zone.registerOrder(reg);
    }

    function test_registerOrder_duplicateBlockedRegardlessOfSender() public {
        OrderRegistration memory reg = _signedReg(taker, "");
        bytes32 orderHash = _orderHash(reg.components);
        zone.registerOrder(reg);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.AlreadyRegistered.selector, orderHash, maker));
        zone.registerOrder(reg);
    }

    /// @dev Dedup is keyed on orderHash. Seaport order hashes commit to offerer,
    /// so an attacker registering their own order cannot consume the victim's hash.
    function test_registerOrder_differentMakersHaveDifferentOrderHashes() public {
        uint256 attackerPk = 0xDEADBEEF;
        address attacker = vm.addr(attackerPk);

        // Attacker registers their own order hash.
        OrderComponents memory attackerComponents = _buildComponents(attacker, taker, DEFAULT_END_TIME);
        bytes32 attackerHash = _orderHash(attackerComponents);
        OrderRegistration memory attackerReg = OrderRegistration({
            components: attackerComponents,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(attackerPk, attackerHash, SEAPORT_SIG, ""),
            memo: ""
        });
        zone.registerOrder(attackerReg);
        assertTrue(zone.registered(attackerHash));

        // Victim (maker) can still register their own components
        OrderRegistration memory victimReg = _signedReg(taker, "");
        bytes32 victimHash = _orderHash(victimReg.components);
        assertTrue(attackerHash != victimHash);
        zone.registerOrder(victimReg);
        assertTrue(zone.registered(victimHash));
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

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.Expired.selector, block.timestamp, block.timestamp - 1));
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

    function test_registerOrder_revertsFutureStartTime() public {
        vm.warp(1_000_000);
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.startTime = block.timestamp + 1;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.FutureStartTime.selector, block.timestamp, block.timestamp + 1)
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
        assertTrue(zone.registered(orderHash));
    }

    /// @dev An expired order must revert without consuming the orderHash slot.
    /// The maker can create a new order (fresh endTime = new hash) and publish.
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
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.Expired.selector, block.timestamp, block.timestamp - 1));
        zone.registerOrder(expiredReg);
        assertFalse(zone.registered(expiredHash));

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
        assertTrue(zone.registered(freshHash));
    }

    // ==================== Memo ====================

    function test_registerOrder_withMemo() public {
        OrderRegistration memory reg = _signedReg(taker, "Looking for any Azuki");
        bytes32 orderHash = _orderHash(reg.components);

        vm.expectEmit(true, true, true, true);
        emit OTCRegistry.OrderRegistered(orderHash, maker, taker, reg.components, "Looking for any Azuki");
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

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.MemoTooLong.selector, 281, zone.MAX_MEMO_LENGTH()));
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
        assertTrue(zone.registered(orderHash));
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

        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.InvalidNativeOfferItem.selector, address(0), uint256(0), 1 ether)
        );
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
        assertTrue(zone.registered(orderHash));
    }

    function test_registerOrder_revertsZeroERC20Amount() public {
        OrderComponents memory components = _buildComponentsWithERC20(maker, taker, weth, usdc);
        components.offer[0].startAmount = 0;
        components.offer[0].endAmount = 0;
        OrderRegistration memory reg =
            OrderRegistration({components: components, seaportSignature: SEAPORT_SIG, signature: "", memo: ""});

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.MissingItemAmount.selector, ItemType.ERC20, weth, 0));
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

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.MissingItemAmount.selector, ItemType.ERC1155, erc1155, 1));
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

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.MissingItemAmount.selector, ItemType.NATIVE, address(0), 0));
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

    function test_registerOrder_revertsPermissiveERC165Token() public {
        address permissiveToken = address(new MockPermissiveERC165Token());
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.offer[0].token = permissiveToken;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(makerPk, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.InvalidTokenStandard.selector, permissiveToken, bytes4(0x80ac58cd))
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

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidERC20Identifier.selector, uint256(1)));
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
        assertTrue(zone.registered(orderHash));
    }

    // ==================== Fuzz: registration lifecycle ====================

    function testFuzz_registerOrderCounterMustMatch(uint256 currentCounter, uint256 providedCounter) public {
        vm.assume(currentCounter != providedCounter);
        mockSeaport.setCounter(maker, currentCounter);

        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.counter = providedCounter;
        OrderRegistration memory reg = _signedRegFromComponents(components, "");

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidCounter.selector, providedCounter, currentCounter));
        zone.registerOrder(reg);
        assertFalse(zone.registered(_orderHash(components)));
    }

    function testFuzz_registerOrderMatchingCounterRegisters(uint256 currentCounter, uint256 salt, address fuzzTaker)
        public
    {
        mockSeaport.setCounter(maker, currentCounter);

        OrderComponents memory components = _buildComponents(maker, fuzzTaker, DEFAULT_END_TIME);
        components.counter = currentCounter;
        components.salt = salt;
        OrderRegistration memory reg = _signedRegFromComponents(components, "");
        bytes32 orderHash = _orderHash(components);

        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash));
    }

    function testFuzz_failedRegistrationDoesNotConsumeSlot(uint256 salt) public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.salt = salt;
        bytes32 orderHash = _orderHash(components);
        OrderRegistration memory reg = OrderRegistration({
            components: components,
            seaportSignature: SEAPORT_SIG,
            signature: _sign(0xB0B, orderHash, SEAPORT_SIG, ""),
            memo: ""
        });

        vm.expectRevert(OTCRegistry.InvalidSignature.selector);
        zone.registerOrder(reg);
        assertFalse(zone.registered(orderHash));
    }

    function testFuzz_duplicateRegisteredOrderAlwaysReverts(uint256 salt) public {
        OrderComponents memory components = _buildComponents(maker, taker, DEFAULT_END_TIME);
        components.salt = salt;
        OrderRegistration memory reg = _signedRegFromComponents(components, "");
        bytes32 orderHash = _orderHash(components);

        zone.registerOrder(reg);

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.AlreadyRegistered.selector, orderHash, maker));
        zone.registerOrder(reg);
        assertTrue(zone.registered(orderHash));
    }

    function testFuzz_registeredOrderValidates(bytes32 salt, address fuzzTaker) public {
        OrderComponents memory components = _buildComponents(maker, fuzzTaker, DEFAULT_END_TIME);
        components.salt = uint256(salt);
        OrderRegistration memory reg = _signedRegFromComponents(components, "");
        bytes32 orderHash = _orderHash(components);
        zone.registerOrder(reg);

        ZoneParameters memory params = _zoneParams(components.zoneHash);
        params.orderHash = orderHash;
        params.offerer = maker;

        vm.prank(seaport);
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function testFuzz_unregisteredOrderNeverValidates(bytes32 orderHash, address offerer) public {
        vm.assume(offerer != address(0));
        ZoneParameters memory params = _zoneParams(bytes32(0));
        params.orderHash = orderHash;
        params.offerer = offerer;

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.OrderNotRegistered.selector, orderHash, offerer));
        zone.validateOrder(params);
    }

    function testFuzz_validateOrderRechecksRuntimeERC20Whitelist(address runtimeToken, bool offerSide) public {
        vm.assume(runtimeToken != weth && runtimeToken != usdc);

        ZoneParameters memory params = _registeredZoneParams(address(0));
        if (offerSide) {
            params.offer = new SpentItem[](1);
            params.offer[0] = SpentItem(ItemType.ERC20, runtimeToken, 0, 1);
        } else {
            params.consideration = new ReceivedItem[](1);
            params.consideration[0] = ReceivedItem(ItemType.ERC20, runtimeToken, 0, 1, payable(maker));
        }

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.TokenNotWhitelisted.selector, runtimeToken));
        zone.validateOrder(params);
    }

    function testFuzz_validateOrderAllowsRuntimeWhitelistedERC20(bool useWeth, bool offerSide) public {
        address token = useWeth ? weth : usdc;
        ZoneParameters memory params = _registeredZoneParams(address(0));
        if (offerSide) {
            params.offer = new SpentItem[](1);
            params.offer[0] = SpentItem(ItemType.ERC20, token, 0, 1);
        } else {
            params.consideration = new ReceivedItem[](1);
            params.consideration[0] = ReceivedItem(ItemType.ERC20, token, 0, 1, payable(maker));
        }

        vm.prank(seaport);
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function testFuzz_authorizeOrderUsesLow160Bits(bytes32 zoneHash, address fulfiller) public {
        address allowedTaker = address(uint160(uint256(zoneHash)));
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = fulfiller;

        vm.prank(seaport);
        if (allowedTaker == address(0) || fulfiller == allowedTaker) {
            bytes4 result = zone.authorizeOrder(params);
            assertEq(result, zone.authorizeOrder.selector);
        } else {
            vm.expectRevert(abi.encodeWithSelector(OTCRegistry.UnauthorizedTaker.selector, fulfiller, allowedTaker));
            zone.authorizeOrder(params);
        }
    }

    // ==================== authorizeOrder ====================

    function test_authorizeOrder_requiresSeaportCaller() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.OnlySeaport.selector, address(this)));
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
        bytes32 zoneHash = _encodeZoneHash(taker, 1);
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = taker;

        vm.prank(seaport);
        bytes4 result = zone.authorizeOrder(params);
        assertEq(result, zone.authorizeOrder.selector);
    }

    function test_authorizeOrder_restrictedTaker_unauthorized() public {
        bytes32 zoneHash = _encodeZoneHash(taker, 1);
        ZoneParameters memory params = _zoneParams(zoneHash);
        params.fulfiller = stranger;

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.UnauthorizedTaker.selector, stranger, taker));
        zone.authorizeOrder(params);
    }

    /// @dev Registration rejects non-canonical zoneHash values; authorizeOrder
    /// only extracts the low 160 bits from the Seaport-provided zone parameters.
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
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.OnlySeaport.selector, address(this)));
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsUnregisteredOrder() public {
        ZoneParameters memory params = _zoneParams(bytes32(0));

        vm.prank(seaport);
        vm.expectRevert(
            abi.encodeWithSelector(OTCRegistry.OrderNotRegistered.selector, params.orderHash, params.offerer)
        );
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
            zoneHash: registered.zoneHash
        });

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidConsiderationCount.selector, 0, 1));
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsExtraDataWithoutTips() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        params.extraData = abi.encode(block.timestamp + 1 days, hex"1234");

        vm.prank(seaport);
        vm.expectRevert(OTCRegistry.UnexpectedExtraData.selector);
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsTipWithoutAuthorization() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        (params,) = _appendSingleTip(params, ReceivedItem(ItemType.ERC20, usdc, 0, 5e6, payable(stranger)));

        vm.prank(seaport);
        vm.expectRevert(OTCRegistry.MissingTipAuthorization.selector);
        zone.validateOrder(params);
    }

    function test_validateOrder_validWhitelistedERC20Tip() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        ReceivedItem memory tip = ReceivedItem(ItemType.ERC20, usdc, 0, 5e6, payable(stranger));
        ReceivedItem[] memory tips;
        (params, tips) = _appendSingleTip(params, tip);
        params.fulfiller = taker;
        uint256 deadline = block.timestamp + 1 days;
        params.extraData = abi.encode(deadline, _signTip(takerPk, params.orderHash, taker, tips, deadline));

        vm.prank(seaport);
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_validNativeTip() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        ReceivedItem memory tip = ReceivedItem(ItemType.NATIVE, address(0), 0, 1 ether, payable(stranger));
        ReceivedItem[] memory tips;
        (params, tips) = _appendSingleTip(params, tip);
        params.fulfiller = taker;
        uint256 deadline = block.timestamp + 1 days;
        params.extraData = abi.encode(deadline, _signTip(takerPk, params.orderHash, taker, tips, deadline));

        vm.prank(seaport);
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function test_validateOrder_revertsExpiredTipAuthorization() public {
        vm.warp(100);
        ZoneParameters memory params = _registeredZoneParams(address(0));
        ReceivedItem memory tip = ReceivedItem(ItemType.ERC20, usdc, 0, 5e6, payable(stranger));
        ReceivedItem[] memory tips;
        (params, tips) = _appendSingleTip(params, tip);
        params.fulfiller = taker;
        uint256 deadline = block.timestamp - 1;
        params.extraData = abi.encode(deadline, _signTip(takerPk, params.orderHash, taker, tips, deadline));

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.TipAuthorizationExpired.selector, block.timestamp, deadline));
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsInvalidTipSignature() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        ReceivedItem memory tip = ReceivedItem(ItemType.ERC20, usdc, 0, 5e6, payable(stranger));
        ReceivedItem[] memory tips;
        (params, tips) = _appendSingleTip(params, tip);
        params.fulfiller = taker;
        uint256 deadline = block.timestamp + 1 days;
        params.extraData = abi.encode(deadline, _signTip(makerPk, params.orderHash, taker, tips, deadline));

        vm.prank(seaport);
        vm.expectRevert(OTCRegistry.InvalidTipSignature.selector);
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsNFTTip() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        ReceivedItem memory tip = ReceivedItem(ItemType.ERC721, erc721, 1, 1, payable(stranger));
        ReceivedItem[] memory tips;
        (params, tips) = _appendSingleTip(params, tip);
        params.fulfiller = taker;
        uint256 deadline = block.timestamp + 1 days;
        params.extraData = abi.encode(deadline, _signTip(takerPk, params.orderHash, taker, tips, deadline));

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidItemType.selector, ItemType.ERC721));
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsNonWhitelistedERC20Tip() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        ReceivedItem memory tip = ReceivedItem(ItemType.ERC20, fakeToken, 0, 5e6, payable(stranger));
        ReceivedItem[] memory tips;
        (params, tips) = _appendSingleTip(params, tip);
        params.fulfiller = taker;
        uint256 deadline = block.timestamp + 1 days;
        params.extraData = abi.encode(deadline, _signTip(takerPk, params.orderHash, taker, tips, deadline));

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.TokenNotWhitelisted.selector, fakeToken));
        zone.validateOrder(params);
    }

    function test_validateOrder_revertsERC20TipWithIdentifier() public {
        ZoneParameters memory params = _registeredZoneParams(address(0));
        ReceivedItem memory tip = ReceivedItem(ItemType.ERC20, usdc, 1, 5e6, payable(stranger));
        ReceivedItem[] memory tips;
        (params, tips) = _appendSingleTip(params, tip);
        params.fulfiller = taker;
        uint256 deadline = block.timestamp + 1 days;
        params.extraData = abi.encode(deadline, _signTip(takerPk, params.orderHash, taker, tips, deadline));

        vm.prank(seaport);
        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidERC20Identifier.selector, uint256(1)));
        zone.validateOrder(params);
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
