// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {OTCZone} from "../src/OTCZone.sol";

// Seaport 1.6 canonical address (same on all chains)
address constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;

contract DeployOTCZoneSepolia is Script {
    function run() external {
        address[] memory tokens = new address[](2);
        tokens[0] = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14; // WETH
        tokens[1] = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238; // USDC

        vm.startBroadcast();
        OTCZone zone = new OTCZone(tokens, SEAPORT);
        vm.stopBroadcast();

        console.log("OTCZone deployed at:", address(zone));
    }
}

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
