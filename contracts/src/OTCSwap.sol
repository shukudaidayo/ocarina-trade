// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract OTCSwap is ReentrancyGuard {
    enum AssetType { ERC721, ERC1155 }
    enum OrderStatus { NONE, OPEN, FILLED, CANCELLED }

    struct Asset {
        address token;
        uint256 tokenId;
        uint256 amount;
        AssetType assetType;
    }

    mapping(bytes32 => OrderStatus) public orders;
    mapping(bytes32 => address) public orderMakers;

    bool public killed;
    address public owner;

    event OrderCreated(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        Asset[] makerAssets,
        Asset[] takerAssets,
        uint256 expiration,
        uint256 salt
    );
    event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker);
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event Killed();

    modifier notKilled() {
        require(!killed, "Contract is killed");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function createOrder(
        address taker,
        Asset[] calldata makerAssets,
        Asset[] calldata takerAssets,
        uint256 expiration,
        uint256 salt
    ) external notKilled returns (bytes32 orderHash) {
        orderHash = _hashOrder(msg.sender, taker, makerAssets, takerAssets, expiration, salt);
        require(orders[orderHash] == OrderStatus.NONE, "Order already exists");

        orders[orderHash] = OrderStatus.OPEN;
        orderMakers[orderHash] = msg.sender;

        emit OrderCreated(orderHash, msg.sender, taker, makerAssets, takerAssets, expiration, salt);
    }

    function fillOrder(
        address maker,
        address taker,
        Asset[] calldata makerAssets,
        Asset[] calldata takerAssets,
        uint256 expiration,
        uint256 salt
    ) external notKilled nonReentrant {
        bytes32 orderHash = _hashOrder(maker, taker, makerAssets, takerAssets, expiration, salt);
        require(orders[orderHash] == OrderStatus.OPEN, "Order not open");
        require(taker == address(0) || taker == msg.sender, "Not authorized taker");
        require(expiration == 0 || block.timestamp <= expiration, "Order expired");

        orders[orderHash] = OrderStatus.FILLED;

        _transferAssets(makerAssets, maker, msg.sender);
        _transferAssets(takerAssets, msg.sender, maker);

        emit OrderFilled(orderHash, maker, msg.sender);
    }

    function cancelOrder(bytes32 orderHash) external {
        require(orders[orderHash] == OrderStatus.OPEN, "Order not open");
        require(orderMakers[orderHash] == msg.sender, "Not order maker");

        orders[orderHash] = OrderStatus.CANCELLED;

        emit OrderCancelled(orderHash, msg.sender);
    }

    function kill() external onlyOwner {
        require(!killed, "Already killed");
        killed = true;
        emit Killed();
    }

    function _hashOrder(
        address maker,
        address taker,
        Asset[] calldata makerAssets,
        Asset[] calldata takerAssets,
        uint256 expiration,
        uint256 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(maker, taker, makerAssets, takerAssets, expiration, salt));
    }

    function _transferAssets(Asset[] calldata assets, address from, address to) internal {
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i].assetType == AssetType.ERC721) {
                IERC721(assets[i].token).transferFrom(from, to, assets[i].tokenId);
            } else {
                IERC1155(assets[i].token).safeTransferFrom(from, to, assets[i].tokenId, assets[i].amount, "");
            }
        }
    }
}
