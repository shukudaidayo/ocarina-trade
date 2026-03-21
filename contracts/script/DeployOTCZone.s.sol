// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {OTCZone} from "../src/OTCZone.sol";

// Seaport 1.6 canonical address (same on all chains)
address constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;

contract DeployOTCZoneMainnet is Script {
    function run() external {
        address[] memory tokens = new address[](5);
        tokens[0] = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // WETH
        tokens[1] = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // USDC
        tokens[2] = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // USDT
        tokens[3] = 0xdC035D45d973E3EC169d2276DDab16f1e407384F; // USDS
        tokens[4] = 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c; // EURC

        vm.startBroadcast();
        OTCZone zone = new OTCZone(tokens, SEAPORT);
        vm.stopBroadcast();

        console.log("OTCZone deployed at:", address(zone));
    }
}

contract DeployOTCZoneBase is Script {
    function run() external {
        address[] memory tokens = new address[](4);
        tokens[0] = 0x4200000000000000000000000000000000000006; // WETH
        tokens[1] = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
        tokens[2] = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc; // USDS
        tokens[3] = 0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42; // EURC

        vm.startBroadcast();
        OTCZone zone = new OTCZone(tokens, SEAPORT);
        vm.stopBroadcast();

        console.log("OTCZone deployed at:", address(zone));
    }
}

contract DeployOTCZonePolygon is Script {
    function run() external {
        address[] memory tokens = new address[](3);
        tokens[0] = 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619; // WETH
        tokens[1] = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359; // USDC
        tokens[2] = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F; // USDT0

        vm.startBroadcast();
        OTCZone zone = new OTCZone(tokens, SEAPORT);
        vm.stopBroadcast();

        console.log("OTCZone deployed at:", address(zone));
    }
}
