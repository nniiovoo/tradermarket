// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Issue 03: deterministic slot market addresses.
contract DeterministicSlotsTest is Test {
    MockUSDC internal usdc;
    LiveMarketFactory internal factory;

    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");
    address internal gateOracle = makeAddr("gateOracle");
    address internal outsider = makeAddr("outsider");

    address internal registeredRoom;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );
        // Only a registered room may mint its own slots, so deterministic
        // addressing is exercised through one.
        registeredRoom = factory.createRoom(_roomConfig(bytes32("room-det")));
    }

    function _roomConfig(bytes32 roomId) internal returns (LiveRoom.RoomConfig memory config) {
        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](1);
        templates[0] = LiveRoom.TemplateRule({templateId: bytes32("tpl"), winnerRewardBps: 100});
        config = LiveRoom.RoomConfig({
            roomId: roomId,
            headlineTemplateId: bytes32("tpl"),
            gateSigner: makeAddr("gate"),
            publisher: makeAddr("pub"),
            integrityAdjudicator: makeAddr("adj"),
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
            bondRecipient: address(this),
            liquidityRouter: address(0),
            resolvers: [makeAddr("r1"), makeAddr("r2"), makeAddr("r3")],
            epochDuration: 30,
            sourceFinalityDelay: 5,
            maxPendingTime: 120,
            challengeWindow: 10 minutes,
            challengeTimeout: 30 minutes,
            minAnnounceDelay: 30,
            maxPermitLifetime: 5 minutes,
            integrityClaimWindow: 1 hours,
            integrityClaimTimeout: 1 hours,
            gateStallTimeout: 6 hours,
            maxOpenSlots: 4,
            participantAName: "Nova",
            participantBName: "Arc",
            templates: templates,
            restrictedWallets: new address[](0)
        });
    }

    function _config(bytes32 roomId, uint32 slotIndex) internal returns (LivePredictionMarket.MarketConfig memory) {
        return LivePredictionMarket.MarketConfig({
            collateral: address(0),
            admin: address(this),
            gateOracle: gateOracle,
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
            bondRecipient: address(this),
            resolvers: [makeAddr("r1"), makeAddr("r2"), makeAddr("r3")],
            epochDuration: 30,
            sourceFinalityDelay: 5,
            maxPendingTime: 120,
            challengeWindow: 10 minutes,
            challengeTimeout: 30 minutes,
            roomId: roomId,
            slotIndex: slotIndex,
            templateId: bytes32("tpl"),
            conditionHash: keccak256("c"),
            winnerRewardBps: 100,
            opensAt: 0,
            readinessSource: address(0),
            liquidityRouter: address(0),
            participantAName: "Nova",
            participantBName: "Arc",
            question: "Q",
            streamUrl: "",
            imageUrl: ""
        });
    }

    function testPredictedAddressMatchesDeployment() public {
        bytes32 roomId = bytes32("room-det");
        address predicted = factory.predictMarketAddress(roomId, 3);
        assertEq(predicted.code.length, 0, "no code before publication");

        vm.prank(registeredRoom);
        address market = factory.createRoomMarket(_config(roomId, 3), new address[](0), roomId, 3);
        assertEq(market, predicted, "deployment lands on the predicted address");
        assertGt(market.code.length, 0);
    }

    function testRepublishingSamePairReverts() public {
        bytes32 roomId = bytes32("room-det");
        vm.prank(registeredRoom);
        factory.createRoomMarket(_config(roomId, 0), new address[](0), roomId, 0);
        LivePredictionMarket.MarketConfig memory again = _config(roomId, 0);
        vm.prank(registeredRoom);
        vm.expectRevert(LiveMarketFactory.SlotAlreadyPublished.selector);
        factory.createRoomMarket(again, new address[](0), roomId, 0);
    }

    function testDistinctRoomsAndSlotsGetDistinctAddresses() public view {
        address a = factory.predictMarketAddress(bytes32("room-1"), 0);
        address b = factory.predictMarketAddress(bytes32("room-1"), 1);
        address c = factory.predictMarketAddress(bytes32("room-2"), 0);
        assertTrue(a != b && a != c && b != c);
    }

    function testStandaloneCreationNeedsTheRoleAndRoomCreationNeedsTheRoom() public {
        LivePredictionMarket.MarketConfig memory standalone = _config(bytes32(0), 0);
        LivePredictionMarket.MarketConfig memory roomSlot = _config(bytes32("room-det"), 0);
        vm.startPrank(outsider);
        vm.expectRevert();
        factory.createMarket(standalone, new address[](0));
        vm.expectRevert(LiveMarketFactory.NotTheRoom.selector);
        factory.createRoomMarket(roomSlot, new address[](0), bytes32("room-det"), 0);
        vm.stopPrank();
    }

    function testStandalonePlainClonePathStillWorks() public {
        address market = factory.createMarket(_config(bytes32(0), 0), new address[](0));
        assertGt(market.code.length, 0);
        assertEq(factory.marketCount(), 1);
    }

    function testDuplicateRoomIdRejected() public {
        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](1);
        templates[0] = LiveRoom.TemplateRule({templateId: bytes32("tpl"), winnerRewardBps: 100});
        LiveRoom.RoomConfig memory config = LiveRoom.RoomConfig({
            roomId: bytes32("room-dup"),
            headlineTemplateId: bytes32("tpl"),
            gateSigner: makeAddr("gate"),
            publisher: makeAddr("pub"),
            integrityAdjudicator: makeAddr("adj"),
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
            bondRecipient: address(this),
            liquidityRouter: address(0),
            resolvers: [makeAddr("r1"), makeAddr("r2"), makeAddr("r3")],
            epochDuration: 30,
            sourceFinalityDelay: 5,
            maxPendingTime: 120,
            challengeWindow: 10 minutes,
            challengeTimeout: 30 minutes,
            minAnnounceDelay: 30,
            maxPermitLifetime: 5 minutes,
            integrityClaimWindow: 1 hours,
            integrityClaimTimeout: 1 hours,
            gateStallTimeout: 6 hours,
            maxOpenSlots: 2,
            participantAName: "Nova",
            participantBName: "Arc",
            templates: templates,
            restrictedWallets: new address[](0)
        });
        factory.createRoom(config);
        LiveRoom.RoomConfig memory again = config;
        vm.expectRevert(LiveMarketFactory.RoomIdTaken.selector);
        factory.createRoom(again);
    }
}
