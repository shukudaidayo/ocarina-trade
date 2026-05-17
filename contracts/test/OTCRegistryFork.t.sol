// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OTCRegistry, OrderRegistration} from "../src/OTCRegistry.sol";
import {
    OrderComponents,
    OrderParameters,
    Order,
    OfferItem,
    ConsiderationItem
} from "seaport-types/lib/ConsiderationStructs.sol";
import {ItemType, OrderType} from "seaport-types/lib/ConsiderationEnums.sol";
import {SeaportInterface} from "seaport-types/interfaces/SeaportInterface.sol";

contract ForkERC721 {
    string public name = "Fork NFT";
    string public symbol = "FORK";

    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "not approved");
        ownerOf[id] = to;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }
}

contract OTCRegistryForkTest is Test {
    address internal constant SEAPORT_1_6 = 0x0000000000000068F116a894984e2DB1123eB395;
    string internal constant PUBLIC_MAINNET_RPC_URL = "https://ethereum-rpc.publicnode.com";

    bytes32 internal constant REGISTRATION_TYPEHASH =
        keccak256("OrderRegistration(bytes32 orderHash,bytes seaportSignature,string memo)");

    SeaportInterface internal seaport;
    OTCRegistry internal zone;
    ForkERC721 internal token;

    uint256 internal makerPk = 0xA11CE;
    uint256 internal takerPk = 0xB0B;
    uint256 internal strangerPk = 0xBAD;
    address internal maker;
    address internal taker;
    address internal stranger;

    function setUp() public {
        string memory rpcUrl = vm.envOr("MAINNET_RPC_URL", PUBLIC_MAINNET_RPC_URL);
        vm.createSelectFork(rpcUrl);

        seaport = SeaportInterface(SEAPORT_1_6);
        maker = vm.addr(makerPk);
        taker = vm.addr(takerPk);
        stranger = vm.addr(strangerPk);

        address[] memory tokens = new address[](0);
        zone = new OTCRegistry(tokens, SEAPORT_1_6);
        token = new ForkERC721();
    }

    function testFork_registerAndFulfillRestrictedOrderThroughRealSeaport() public {
        token.mint(maker, 1);
        token.mint(taker, 2);

        _approve(maker);
        _approve(taker);

        OrderComponents memory components = _buildComponents(1, taker);
        bytes memory seaportSignature = _signSeaportOrder(components);
        bytes32 orderHash = seaport.getOrderHash(components);

        zone.registerOrder(_registration(components, orderHash, seaportSignature, ""));
        assertTrue(zone.registered(orderHash));

        vm.prank(taker);
        bool fulfilled = seaport.fulfillOrder(_order(components, ""), bytes32(0));

        assertTrue(fulfilled);
        assertEq(token.ownerOf(1), taker);
        assertEq(token.ownerOf(2), maker);

        (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize) = seaport.getOrderStatus(orderHash);
        assertTrue(isValidated);
        assertFalse(isCancelled);
        assertEq(totalFilled, totalSize);
    }

    function testFork_wrongTakerCannotFulfillRestrictedOrder() public {
        token.mint(maker, 1);
        token.mint(taker, 2);

        _approve(maker);
        _approve(stranger);

        OrderComponents memory components = _buildComponents(2, taker);
        bytes memory seaportSignature = _signSeaportOrder(components);
        bytes32 orderHash = seaport.getOrderHash(components);
        zone.registerOrder(_registration(components, orderHash, seaportSignature, ""));

        vm.prank(stranger);
        vm.expectRevert();
        seaport.fulfillOrder(_order(components, seaportSignature), bytes32(0));

        assertEq(token.ownerOf(1), maker);
        assertEq(token.ownerOf(2), taker);
    }

    function testFork_unregisteredOrderCannotFulfillThroughRegistryZone() public {
        token.mint(maker, 1);
        token.mint(taker, 2);

        _approve(maker);
        _approve(taker);

        OrderComponents memory components = _buildComponents(3, taker);
        bytes memory seaportSignature = _signSeaportOrder(components);

        vm.prank(taker);
        vm.expectRevert();
        seaport.fulfillOrder(_order(components, seaportSignature), bytes32(0));

        assertEq(token.ownerOf(1), maker);
        assertEq(token.ownerOf(2), taker);
    }

    function testFork_prevalidatedOrderCanRegisterWithGarbageSeaportSignature() public {
        OrderComponents memory components = _buildComponents(4, taker);
        bytes memory validSeaportSignature = _signSeaportOrder(components);
        bytes32 orderHash = seaport.getOrderHash(components);

        Order[] memory orders = new Order[](1);
        orders[0] = _order(components, validSeaportSignature);
        assertTrue(seaport.validate(orders));

        bytes memory garbageSeaportSignature = hex"badbad";
        zone.registerOrder(_registration(components, orderHash, garbageSeaportSignature, ""));
        assertTrue(zone.registered(orderHash));
    }

    function _buildComponents(uint256 salt, address allowedTaker) internal view returns (OrderComponents memory) {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem({
            itemType: ItemType.ERC721, token: address(token), identifierOrCriteria: 1, startAmount: 1, endAmount: 1
        });

        ConsiderationItem[] memory consideration = new ConsiderationItem[](1);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC721,
            token: address(token),
            identifierOrCriteria: 2,
            startAmount: 1,
            endAmount: 1,
            recipient: payable(maker)
        });

        return OrderComponents({
            offerer: maker,
            zone: address(zone),
            offer: offer,
            consideration: consideration,
            orderType: OrderType.FULL_RESTRICTED,
            startTime: block.timestamp,
            endTime: block.timestamp + 30 days,
            zoneHash: bytes32(uint256(uint160(allowedTaker))),
            salt: salt,
            conduitKey: bytes32(0),
            counter: seaport.getCounter(maker)
        });
    }

    function _order(OrderComponents memory components, bytes memory signature) internal pure returns (Order memory) {
        return Order({
            parameters: OrderParameters({
                offerer: components.offerer,
                zone: components.zone,
                offer: components.offer,
                consideration: components.consideration,
                orderType: components.orderType,
                startTime: components.startTime,
                endTime: components.endTime,
                zoneHash: components.zoneHash,
                salt: components.salt,
                conduitKey: components.conduitKey,
                totalOriginalConsiderationItems: components.consideration.length
            }),
            signature: signature
        });
    }

    function _registration(
        OrderComponents memory components,
        bytes32 orderHash,
        bytes memory seaportSignature,
        string memory memo
    ) internal view returns (OrderRegistration memory) {
        return OrderRegistration({
            components: components,
            seaportSignature: seaportSignature,
            signature: _signRegistration(orderHash, seaportSignature, memo),
            memo: memo
        });
    }

    function _signSeaportOrder(OrderComponents memory components) internal view returns (bytes memory) {
        (, bytes32 domainSeparator,) = seaport.information();
        bytes32 orderHash = seaport.getOrderHash(components);
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator, orderHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signRegistration(bytes32 orderHash, bytes memory seaportSignature, string memory memo)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(REGISTRATION_TYPEHASH, orderHash, keccak256(seaportSignature), keccak256(bytes(memo)))
        );
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), zone.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _approve(address owner) internal {
        vm.prank(owner);
        token.setApprovalForAll(SEAPORT_1_6, true);
    }
}
