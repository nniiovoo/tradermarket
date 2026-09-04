// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";

contract DeployAmoy is Script {
    address internal constant CIRCLE_TEST_USDC = 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582;

    function run() external returns (LivePredictionMarket implementation, LiveMarketFactory factory) {
        LiveRoom roomImplementation;
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address admin = vm.envOr("MARKET_ADMIN", deployer);

        vm.startBroadcast(deployerKey);
        implementation = new LivePredictionMarket();
        roomImplementation = new LiveRoom();
        factory = new LiveMarketFactory(CIRCLE_TEST_USDC, admin, address(implementation), address(roomImplementation));
        vm.stopBroadcast();

        console2.log("Polygon Amoy market implementation", address(implementation));
        console2.log("Polygon Amoy room implementation", address(roomImplementation));
        console2.log("Polygon Amoy market factory", address(factory));
        console2.log("Circle test USDC", CIRCLE_TEST_USDC);
        console2.log("Factory administrator", admin);
    }
}
