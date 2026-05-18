// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OTCRegistry, OrderRegistration} from "../src/OTCRegistry.sol";
import {
    ZoneParameters,
    SpentItem,
    ReceivedItem,
    OrderComponents,
    Order,
    OfferItem,
    ConsiderationItem
} from "seaport-types/lib/ConsiderationStructs.sol";
import {ItemType, OrderType} from "seaport-types/lib/ConsiderationEnums.sol";

contract InvariantMockSeaport {
    mapping(address => uint256) public counters;

    function setCounter(address offerer, uint256 counter) external {
        counters[offerer] = counter;
    }

    function getOrderHash(OrderComponents calldata order) external pure returns (bytes32) {
        return keccak256(abi.encode(order));
    }

    function getCounter(address offerer) external view returns (uint256) {
        return counters[offerer];
    }

    function validate(Order[] calldata) external pure returns (bool) {
        return true;
    }
}

contract InvariantERC165Token {
    bytes4 private immutable supportedInterface;

    constructor(bytes4 _supportedInterface) {
        supportedInterface = _supportedInterface;
    }

    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        return interfaceId == supportedInterface || interfaceId == 0x01ffc9a7;
    }
}

contract OTCRegistryInvariantHandler is Test {
    OTCRegistry public immutable zone;
    InvariantMockSeaport public immutable seaport;
    address public immutable erc721;
    address public immutable maker;
    uint256 public immutable makerPk;

    bytes internal constant SEAPORT_SIG = hex"deadbeefdeadbeef";
    bytes32 internal constant REGISTRATION_TYPEHASH =
        keccak256("OrderRegistration(bytes32 orderHash,bytes seaportSignature,string memo)");
    uint256 internal constant DEFAULT_END_TIME = 1e18;
    uint256 internal constant MAX_TRACKED_REGISTRATIONS = 32;

    bytes32[] public registeredHashes;
    mapping(bytes32 => bool) public seenRegistered;
    mapping(bytes32 => bytes32) public registeredZoneHash;

    constructor(OTCRegistry _zone, InvariantMockSeaport _seaport, address _erc721, uint256 _makerPk) {
        zone = _zone;
        seaport = _seaport;
        erc721 = _erc721;
        makerPk = _makerPk;
        maker = vm.addr(_makerPk);
    }

    function registerValid(uint96 salt, address taker) external {
        if (registeredHashes.length >= MAX_TRACKED_REGISTRATIONS) return;

        OrderComponents memory components = _buildComponents(salt, taker, DEFAULT_END_TIME);
        OrderRegistration memory reg = _signedReg(components, makerPk);
        bytes32 orderHash = _orderHash(components);

        if (seenRegistered[orderHash]) {
            vm.expectRevert(OTCRegistry.AlreadyRegistered.selector);
            zone.registerOrder(reg);
            return;
        }

        zone.registerOrder(reg);
        seenRegistered[orderHash] = true;
        registeredZoneHash[orderHash] = components.zoneHash;
        registeredHashes.push(orderHash);
        assertTrue(zone.registered(orderHash));
    }

    function failedRegistrationDoesNotConsumeSlot(uint96 salt, address taker, uint256 badPk) external {
        badPk = bound(badPk, 1, type(uint128).max);
        vm.assume(badPk != makerPk);

        OrderComponents memory components = _buildComponents(salt, taker, DEFAULT_END_TIME);
        bytes32 orderHash = _orderHash(components);
        vm.assume(!seenRegistered[orderHash]);

        OrderRegistration memory reg = _signedReg(components, badPk);
        vm.expectRevert(OTCRegistry.InvalidSignature.selector);
        zone.registerOrder(reg);
        assertFalse(zone.registered(orderHash));
    }

    function staleCounterDoesNotConsumeSlot(uint96 salt, address taker, uint32 currentCounter) external {
        OrderComponents memory components = _buildComponents(salt, taker, DEFAULT_END_TIME);

        uint256 providedCounter = uint256(currentCounter) + 1;
        seaport.setCounter(maker, currentCounter);
        components.counter = providedCounter;
        bytes32 orderHash = _orderHash(components);
        vm.assume(!seenRegistered[orderHash]);
        OrderRegistration memory reg = _signedReg(components, makerPk);

        vm.expectRevert(abi.encodeWithSelector(OTCRegistry.InvalidCounter.selector, providedCounter, currentCounter));
        zone.registerOrder(reg);
        assertFalse(zone.registered(orderHash));
        seaport.setCounter(maker, 0);
    }

    function validateRegistered(uint256 index) external {
        if (registeredHashes.length == 0) return;

        bytes32 orderHash = registeredHashes[index % registeredHashes.length];
        ZoneParameters memory params = _zoneParams(orderHash);
        params.zoneHash = registeredZoneHash[orderHash];

        vm.prank(address(seaport));
        bytes4 result = zone.validateOrder(params);
        assertEq(result, zone.validateOrder.selector);
    }

    function validateUnregistered(bytes32 orderHash) external {
        vm.assume(!seenRegistered[orderHash]);

        ZoneParameters memory params = _zoneParams(orderHash);
        vm.prank(address(seaport));
        vm.expectRevert(OTCRegistry.OrderNotRegistered.selector);
        zone.validateOrder(params);
    }

    function registeredCount() external view returns (uint256) {
        return registeredHashes.length;
    }

    function registeredHashAt(uint256 index) external view returns (bytes32) {
        return registeredHashes[index];
    }

    function _buildComponents(uint96 salt, address taker, uint256 endTime)
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
            recipient: payable(maker)
        });

        bytes32 zoneHash = _encodeZoneHash(taker, consideration.length);

        return OrderComponents({
            offerer: maker,
            zone: address(zone),
            offer: offer,
            consideration: consideration,
            orderType: OrderType.FULL_RESTRICTED,
            startTime: 0,
            endTime: endTime,
            zoneHash: zoneHash,
            salt: salt,
            conduitKey: bytes32(0),
            counter: seaport.getCounter(maker)
        });
    }

    function _signedReg(OrderComponents memory components, uint256 pk)
        internal
        view
        returns (OrderRegistration memory)
    {
        bytes32 orderHash = _orderHash(components);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(orderHash, ""));
        return OrderRegistration({
            components: components, seaportSignature: SEAPORT_SIG, signature: abi.encodePacked(r, s, v), memo: ""
        });
    }

    function _orderHash(OrderComponents memory components) internal view returns (bytes32) {
        return seaport.getOrderHash(components);
    }

    function _digest(bytes32 orderHash, string memory memo) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(REGISTRATION_TYPEHASH, orderHash, keccak256(SEAPORT_SIG), keccak256(bytes(memo))));
        return keccak256(abi.encodePacked(bytes2(0x1901), zone.DOMAIN_SEPARATOR(), structHash));
    }

    function _zoneParams(bytes32 orderHash) internal view returns (ZoneParameters memory) {
        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(ItemType.ERC721, erc721, 1, 1);

        ReceivedItem[] memory consideration = new ReceivedItem[](1);
        consideration[0] = ReceivedItem(ItemType.ERC721, erc721, 2, 1, payable(maker));

        bytes32[] memory orderHashes = new bytes32[](0);

        return ZoneParameters({
            orderHash: orderHash,
            fulfiller: address(0xB0B),
            offerer: maker,
            offer: offer,
            consideration: consideration,
            extraData: "",
            orderHashes: orderHashes,
            startTime: block.timestamp,
            endTime: block.timestamp + 30 days,
            zoneHash: _encodeZoneHash(address(0), consideration.length)
        });
    }

    function _encodeZoneHash(address taker, uint256 originalConsiderationCount) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(taker)) | (originalConsiderationCount << 160) | (uint256(1) << 192));
    }
}

contract OTCRegistryInvariantTest is Test {
    OTCRegistry public zone;
    InvariantMockSeaport public seaport;
    InvariantERC165Token public erc721;
    OTCRegistryInvariantHandler public handler;

    uint256 internal constant MAKER_PK = 0xA11CE;

    function setUp() public {
        seaport = new InvariantMockSeaport();
        erc721 = new InvariantERC165Token(0x80ac58cd);

        address[] memory tokens = new address[](1);
        tokens[0] = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
        zone = new OTCRegistry(tokens, address(seaport));

        handler = new OTCRegistryInvariantHandler(zone, seaport, address(erc721), MAKER_PK);
        targetContract(address(handler));
    }

    function invariant_registeredOrdersStayRegisteredAndValidate() public view {
        uint256 count = handler.registeredCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 orderHash = handler.registeredHashAt(i);
            assertTrue(zone.registered(orderHash));
        }
    }
}
