// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OTCSwap.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract MockERC721 is ERC721 {
    constructor() ERC721("Mock721", "M721") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

contract MockERC1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

contract MaliciousERC1155 is ERC1155 {
    OTCSwap public swap;
    address public attacker;
    bool public attacking;

    // Store fill params for reentrancy
    address public fillMaker;
    address public fillTaker;
    OTCSwap.Asset[] public fillMakerAssets;
    OTCSwap.Asset[] public fillTakerAssets;
    uint256 public fillExpiration;
    uint256 public fillSalt;

    constructor(address _swap) ERC1155("") {
        swap = OTCSwap(_swap);
    }

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }

    function setAttack(
        address _attacker,
        address _fillMaker,
        address _fillTaker,
        OTCSwap.Asset[] calldata _makerAssets,
        OTCSwap.Asset[] calldata _takerAssets,
        uint256 _expiration,
        uint256 _salt
    ) external {
        attacker = _attacker;
        fillMaker = _fillMaker;
        fillTaker = _fillTaker;
        delete fillMakerAssets;
        for (uint256 i = 0; i < _makerAssets.length; i++) {
            fillMakerAssets.push(_makerAssets[i]);
        }
        delete fillTakerAssets;
        for (uint256 i = 0; i < _takerAssets.length; i++) {
            fillTakerAssets.push(_takerAssets[i]);
        }
        fillExpiration = _expiration;
        fillSalt = _salt;
        attacking = true;
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory data
    ) public override {
        if (attacking) {
            attacking = false; // prevent infinite loop
            swap.fillOrder(
                fillMaker,
                fillTaker,
                fillMakerAssets,
                fillTakerAssets,
                fillExpiration,
                fillSalt
            );
        }
        super.safeTransferFrom(from, to, id, amount, data);
    }

    function getMakerAssets() external view returns (OTCSwap.Asset[] memory) {
        return fillMakerAssets;
    }

    function getTakerAssets() external view returns (OTCSwap.Asset[] memory) {
        return fillTakerAssets;
    }
}

contract OTCSwapTest is Test {
    OTCSwap public swap;
    MockERC721 public nft721;
    MockERC1155 public nft1155;

    address public maker = address(0x1);
    address public taker = address(0x2);
    address public stranger = address(0x3);

    function setUp() public {
        swap = new OTCSwap();
        nft721 = new MockERC721();
        nft1155 = new MockERC1155();

        // Mint tokens to maker and taker
        nft721.mint(maker, 1);
        nft721.mint(taker, 2);
        nft1155.mint(maker, 10, 5);
        nft1155.mint(taker, 20, 5);

        // Approve swap contract
        vm.prank(maker);
        nft721.setApprovalForAll(address(swap), true);
        vm.prank(taker);
        nft721.setApprovalForAll(address(swap), true);
        vm.prank(maker);
        nft1155.setApprovalForAll(address(swap), true);
        vm.prank(taker);
        nft1155.setApprovalForAll(address(swap), true);
    }

    function _makerAssets721() internal view returns (OTCSwap.Asset[] memory) {
        OTCSwap.Asset[] memory assets = new OTCSwap.Asset[](1);
        assets[0] = OTCSwap.Asset(address(nft721), 1, 1, OTCSwap.AssetType.ERC721);
        return assets;
    }

    function _takerAssets721() internal view returns (OTCSwap.Asset[] memory) {
        OTCSwap.Asset[] memory assets = new OTCSwap.Asset[](1);
        assets[0] = OTCSwap.Asset(address(nft721), 2, 1, OTCSwap.AssetType.ERC721);
        return assets;
    }

    function _makerAssets1155() internal view returns (OTCSwap.Asset[] memory) {
        OTCSwap.Asset[] memory assets = new OTCSwap.Asset[](1);
        assets[0] = OTCSwap.Asset(address(nft1155), 10, 3, OTCSwap.AssetType.ERC1155);
        return assets;
    }

    function _takerAssets1155() internal view returns (OTCSwap.Asset[] memory) {
        OTCSwap.Asset[] memory assets = new OTCSwap.Asset[](1);
        assets[0] = OTCSwap.Asset(address(nft1155), 20, 3, OTCSwap.AssetType.ERC1155);
        return assets;
    }

    // ==================== createOrder ====================

    // 1. Success — returns hash, status OPEN, maker stored, event emitted
    function test_createOrder_success() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        vm.expectEmit(true, true, true, true);
        // Compute expected hash
        bytes32 expectedHash = keccak256(abi.encode(maker, taker, ma, ta, uint256(0), uint256(1)));
        emit OTCSwap.OrderCreated(expectedHash, maker, taker, ma, ta, 0, 1);

        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        assertEq(orderHash, expectedHash);
        assertEq(uint256(swap.orders(orderHash)), uint256(OTCSwap.OrderStatus.OPEN));
        assertEq(swap.orderMakers(orderHash), maker);
    }

    // 2. Duplicate reverts
    function test_createOrder_duplicate_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(maker);
        vm.expectRevert("Order already exists");
        swap.createOrder(taker, ma, ta, 0, 1);
    }

    // 3. Killed reverts
    function test_createOrder_killed_reverts() public {
        swap.kill();

        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        vm.expectRevert("Contract is killed");
        swap.createOrder(taker, ma, ta, 0, 1);
    }

    // 4. Open taker (address(0)) succeeds
    function test_createOrder_openTaker() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(address(0), ma, ta, 0, 1);

        assertEq(uint256(swap.orders(orderHash)), uint256(OTCSwap.OrderStatus.OPEN));
    }

    // 5. No expiration (0) succeeds
    function test_createOrder_noExpiration() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        assertEq(uint256(swap.orders(orderHash)), uint256(OTCSwap.OrderStatus.OPEN));
    }

    // ==================== fillOrder ====================

    // 6. Success — full happy path
    function test_fillOrder_success() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(taker);
        swap.fillOrder(maker, taker, ma, ta, 0, 1);

        assertEq(uint256(swap.orders(orderHash)), uint256(OTCSwap.OrderStatus.FILLED));
        // Maker's NFT went to taker
        assertEq(nft721.ownerOf(1), taker);
        // Taker's NFT went to maker
        assertEq(nft721.ownerOf(2), maker);
    }

    // 7. Wrong taker reverts
    function test_fillOrder_wrongTaker_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(stranger);
        vm.expectRevert("Not authorized taker");
        swap.fillOrder(maker, taker, ma, ta, 0, 1);
    }

    // 8. Open taker — any address can fill
    function test_fillOrder_openTaker() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        swap.createOrder(address(0), ma, ta, 0, 1);

        // Give stranger the taker's NFT for the fill
        vm.prank(taker);
        nft721.transferFrom(taker, stranger, 2);
        vm.prank(stranger);
        nft721.setApprovalForAll(address(swap), true);

        vm.prank(stranger);
        swap.fillOrder(maker, address(0), ma, ta, 0, 1);

        assertEq(nft721.ownerOf(1), stranger);
        assertEq(nft721.ownerOf(2), maker);
    }

    // 9. Expired reverts
    function test_fillOrder_expired_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        uint256 expiration = block.timestamp + 100;
        vm.prank(maker);
        swap.createOrder(taker, ma, ta, expiration, 1);

        vm.warp(expiration + 1);

        vm.prank(taker);
        vm.expectRevert("Order expired");
        swap.fillOrder(maker, taker, ma, ta, expiration, 1);
    }

    // 10. No expiration — works after large time warp
    function test_fillOrder_noExpiration_works() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        swap.createOrder(taker, ma, ta, 0, 1);

        vm.warp(block.timestamp + 365 days * 100);

        vm.prank(taker);
        swap.fillOrder(maker, taker, ma, ta, 0, 1);

        assertEq(nft721.ownerOf(1), taker);
    }

    // 11. Already filled reverts
    function test_fillOrder_alreadyFilled_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(taker);
        swap.fillOrder(maker, taker, ma, ta, 0, 1);

        vm.prank(taker);
        vm.expectRevert("Order not open");
        swap.fillOrder(maker, taker, ma, ta, 0, 1);
    }

    // 12. Already cancelled reverts
    function test_fillOrder_alreadyCancelled_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(maker);
        swap.cancelOrder(orderHash);

        vm.prank(taker);
        vm.expectRevert("Order not open");
        swap.fillOrder(maker, taker, ma, ta, 0, 1);
    }

    // 13. Killed reverts
    function test_fillOrder_killed_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        swap.createOrder(taker, ma, ta, 0, 1);

        swap.kill();

        vm.prank(taker);
        vm.expectRevert("Contract is killed");
        swap.fillOrder(maker, taker, ma, ta, 0, 1);
    }

    // 14. Reentrancy reverts
    function test_fillOrder_reentrancy_reverts() public {
        MaliciousERC1155 malicious = new MaliciousERC1155(address(swap));
        malicious.mint(maker, 100, 1);

        // Maker approves
        vm.prank(maker);
        malicious.setApprovalForAll(address(swap), true);

        OTCSwap.Asset[] memory ma = new OTCSwap.Asset[](1);
        ma[0] = OTCSwap.Asset(address(malicious), 100, 1, OTCSwap.AssetType.ERC1155);

        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        swap.createOrder(taker, ma, ta, 0, 1);

        // Set up the reentrancy attack — when the malicious token is transferred
        // during fillOrder, it tries to call fillOrder again
        malicious.setAttack(taker, maker, taker, ma, ta, 0, 1);

        vm.prank(taker);
        vm.expectRevert();
        swap.fillOrder(maker, taker, ma, ta, 0, 1);
    }

    // 15. Multi-asset swap
    function test_fillOrder_multiAsset() public {
        // Mint extra tokens
        nft721.mint(maker, 3);
        nft1155.mint(taker, 30, 10);

        OTCSwap.Asset[] memory ma = new OTCSwap.Asset[](2);
        ma[0] = OTCSwap.Asset(address(nft721), 1, 1, OTCSwap.AssetType.ERC721);
        ma[1] = OTCSwap.Asset(address(nft721), 3, 1, OTCSwap.AssetType.ERC721);

        OTCSwap.Asset[] memory ta = new OTCSwap.Asset[](2);
        ta[0] = OTCSwap.Asset(address(nft721), 2, 1, OTCSwap.AssetType.ERC721);
        ta[1] = OTCSwap.Asset(address(nft1155), 30, 5, OTCSwap.AssetType.ERC1155);

        vm.prank(maker);
        swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(taker);
        swap.fillOrder(maker, taker, ma, ta, 0, 1);

        assertEq(nft721.ownerOf(1), taker);
        assertEq(nft721.ownerOf(3), taker);
        assertEq(nft721.ownerOf(2), maker);
        assertEq(nft1155.balanceOf(maker, 30), 5);
    }

    // ==================== cancelOrder ====================

    // 16. Success
    function test_cancelOrder_success() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(maker);
        vm.expectEmit(true, true, false, false);
        emit OTCSwap.OrderCancelled(orderHash, maker);
        swap.cancelOrder(orderHash);

        assertEq(uint256(swap.orders(orderHash)), uint256(OTCSwap.OrderStatus.CANCELLED));
    }

    // 17. Wrong caller reverts
    function test_cancelOrder_wrongCaller_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(stranger);
        vm.expectRevert("Not order maker");
        swap.cancelOrder(orderHash);
    }

    // 18. Already filled reverts
    function test_cancelOrder_alreadyFilled_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(taker);
        swap.fillOrder(maker, taker, ma, ta, 0, 1);

        vm.prank(maker);
        vm.expectRevert("Order not open");
        swap.cancelOrder(orderHash);
    }

    // 19. Already cancelled reverts
    function test_cancelOrder_alreadyCancelled_reverts() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        vm.prank(maker);
        swap.cancelOrder(orderHash);

        vm.prank(maker);
        vm.expectRevert("Order not open");
        swap.cancelOrder(orderHash);
    }

    // 20. Works when killed
    function test_cancelOrder_worksWhenKilled() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 1);

        swap.kill();

        vm.prank(maker);
        swap.cancelOrder(orderHash);

        assertEq(uint256(swap.orders(orderHash)), uint256(OTCSwap.OrderStatus.CANCELLED));
    }

    // ==================== kill ====================

    // 21. Success
    function test_kill_success() public {
        assertFalse(swap.killed());
        swap.kill();
        assertTrue(swap.killed());
    }

    // 22. Non-owner reverts
    function test_kill_nonOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert("Not owner");
        swap.kill();
    }

    // 23. Double kill reverts
    function test_kill_doubleKill_reverts() public {
        swap.kill();
        vm.expectRevert("Already killed");
        swap.kill();
    }

    // ==================== Edge cases ====================

    // 24. Exact expiration succeeds
    function test_fillOrder_exactExpiration_succeeds() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        uint256 expiration = block.timestamp + 100;
        vm.prank(maker);
        swap.createOrder(taker, ma, ta, expiration, 1);

        vm.warp(expiration); // exactly at expiration

        vm.prank(taker);
        swap.fillOrder(maker, taker, ma, ta, expiration, 1);

        assertEq(nft721.ownerOf(1), taker);
    }

    // 25. Hash is deterministic
    function test_hashIsDeterministic() public {
        OTCSwap.Asset[] memory ma = _makerAssets721();
        OTCSwap.Asset[] memory ta = _takerAssets721();

        bytes32 manualHash = keccak256(abi.encode(maker, taker, ma, ta, uint256(0), uint256(42)));

        vm.prank(maker);
        bytes32 orderHash = swap.createOrder(taker, ma, ta, 0, 42);

        assertEq(orderHash, manualHash);
    }
}
