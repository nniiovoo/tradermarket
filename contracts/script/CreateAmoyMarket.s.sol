// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";

contract CreateAmoyMarket is Script {
    function run() external returns (address market) {
        uint256 creatorKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address creator = vm.addr(creatorKey);
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        address participantA = vm.envAddress("PARTICIPANT_A");
        address participantB = vm.envAddress("PARTICIPANT_B");
        address gateOracle = vm.envAddress("GATE_ORACLE");
        address resolver1 = vm.envAddress("RESOLVER_1");
        address resolver2 = vm.envAddress("RESOLVER_2");
        address resolver3 = vm.envAddress("RESOLVER_3");
        address bondRecipient = vm.envOr("BOND_RECIPIENT", creator);

        LivePredictionMarket.MarketConfig memory config = LivePredictionMarket.MarketConfig({
            collateral: address(0),
            admin: creator,
            gateOracle: gateOracle,
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: vm.envOr("REWARD_ADDRESS_A", participantA),
            rewardAddressB: vm.envOr("REWARD_ADDRESS_B", participantB),
            bondRecipient: bondRecipient,
            resolvers: [resolver1, resolver2, resolver3],
            epochDuration: uint64(vm.envOr("EPOCH_DURATION", uint256(30))),
            sourceFinalityDelay: uint64(vm.envOr("SOURCE_FINALITY_DELAY", uint256(10))),
            maxPendingTime: uint64(vm.envOr("MAX_PENDING_TIME", uint256(180))),
            challengeWindow: uint64(vm.envOr("CHALLENGE_WINDOW", uint256(600))),
            challengeTimeout: uint64(vm.envOr("CHALLENGE_TIMEOUT", uint256(1800))),
            roomId: bytes32(0),
            slotIndex: 0,
            templateId: bytes32(0),
            conditionHash: bytes32(0),
            winnerRewardBps: uint16(vm.envOr("WINNER_REWARD_BPS", uint256(100))),
            opensAt: 0,
            readinessSource: address(0),
            liquidityRouter: address(0),
            participantAName: vm.envString("PARTICIPANT_A_NAME"),
            participantBName: vm.envString("PARTICIPANT_B_NAME"),
            question: vm.envString("MARKET_QUESTION"),
            streamUrl: vm.envString("STREAM_URL"),
            imageUrl: vm.envString("IMAGE_URL")
        });
        address[] memory restricted = new address[](0);

        vm.startBroadcast(creatorKey);
        market = LiveMarketFactory(factoryAddress).createMarket(config, restricted);
        vm.stopBroadcast();

        console2.log("Competition Market", market);
    }
}
