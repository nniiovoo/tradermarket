// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// The design promises that failure never traps funds: pending actions refund,
/// unresolved markets invalidate, and anyone can push those paths through. But
/// `closeRoom` was gate-only, so a lost or dead gate key left the room open
/// forever — and with it every Integrity Bond, every LP position, and every
/// Outcome Position, permanently unclaimable. Nothing about that failed closed;
/// it failed *stuck*, which is worse.
///
/// A frozen stall timeout gives the room a permissionless close.
contract GateStallRecoveryTest is Test {
    uint256 private constant U = 1e6;
    bytes32 private constant TPL_HEADLINE = bytes32("tpl-participant-v1");
    bytes32 private constant TPL_THRESHOLD = bytes32("tpl-threshold-v1");

    MockUSDC internal usdc;
    LiveMarketFactory internal factory;
    LiveRoom internal room;

    uint256 internal gatePk = 0xA11CE;
    address internal gateSigner;
    address internal publisher = makeAddr("publisher");
    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");
    address internal resolver1 = makeAddr("resolver1");
    address internal resolver2 = makeAddr("resolver2");
    address internal resolver3 = makeAddr("resolver3");
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");
    address internal keeper = makeAddr("keeper");

    uint64 internal constant STALL_TIMEOUT = 6 hours;
    uint256 internal nextNonce = 1;
    uint256 internal seq = 1000;

    function setUp() public {
        vm.warp(1_700_000_000);
        gateSigner = vm.addr(gatePk);
        usdc = new MockUSDC();
        factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );
        room = LiveRoom(factory.createRoom(_config()));
        address[] memory actors = _actors();
        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], 100_000 * U);
        }
        _postBonds();
    }

    function _actors() internal view returns (address[] memory list) {
        list = new address[](5);
        list[0] = participantA;
        list[1] = participantB;
        list[2] = lp;
        list[3] = trader;
        list[4] = keeper;
    }

    function _config() internal returns (LiveRoom.RoomConfig memory config) {
        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](2);
        templates[0] = LiveRoom.TemplateRule({templateId: TPL_HEADLINE, winnerRewardBps: 100});
        templates[1] = LiveRoom.TemplateRule({templateId: TPL_THRESHOLD, winnerRewardBps: 0});
        config = LiveRoom.RoomConfig({
            roomId: bytes32("room-stall"),
            headlineTemplateId: TPL_HEADLINE,
            gateSigner: gateSigner,
            publisher: publisher,
            integrityAdjudicator: makeAddr("adjudicator"),
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
            bondRecipient: makeAddr("bondRecipient"),
            liquidityRouter: address(0),
            resolvers: [resolver1, resolver2, resolver3],
            epochDuration: 10,
            sourceFinalityDelay: 10,
            maxPendingTime: 90,
            challengeWindow: 10 minutes,
            challengeTimeout: 30 minutes,
            minAnnounceDelay: 30,
            maxPermitLifetime: 5 minutes,
            integrityClaimWindow: 1 hours,
            integrityClaimTimeout: 1 hours,
            gateStallTimeout: STALL_TIMEOUT,
            maxOpenSlots: 4,
            participantAName: "Alice",
            participantBName: "Bob",
            templates: templates,
            restrictedWallets: new address[](0)
        });
    }

    function _postBonds() internal {
        vm.startPrank(participantA);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
    }

    function _publish(bytes32 templateId, uint16 bps, string memory question) internal returns (LivePredictionMarket) {
        LiveRoom.SlotRequest memory request = LiveRoom.SlotRequest({
            templateId: templateId,
            templateParamsHash: keccak256(abi.encode(templateId, question)),
            conditionHash: keccak256(abi.encode("condition", question)),
            announceDelay: 30,
            winnerRewardBps: bps,
            question: question,
            streamUrl: "",
            imageUrl: ""
        });
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = LiveRoom.PublicationPermit({
            slotIndex: uint32(room.slotCount()),
            requestHash: room.slotRequestHash(request, restricted),
            conditionHash: request.conditionHash,
            undecidedThroughSequence: seq++,
            announceDelay: 30,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 2 minutes),
            nonce: nextNonce++
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(gatePk, room.permitDigest(permit));
        vm.prank(publisher);
        return LivePredictionMarket(room.publishSlot(request, permit, abi.encodePacked(r, s, v), restricted));
    }

    function _seed(LivePredictionMarket market, uint256 amount) internal {
        if (block.timestamp < market.opensAt()) vm.warp(market.opensAt());
        uint64 epoch = market.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(market), amount);
        market.submitAddLiquidity(amount, 1, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
        vm.warp(market.epochEndsAt(epoch) + 11);
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);
        room.processRoom(markets, epochs, type(uint256).max);
    }

    /// A gate that dies mid-session must not be able to freeze the room's money.
    function testAStalledGateCannotTrapCollateralForever() public {
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline, 1_000 * U);

        uint64 buyEpoch = headline.currentEpoch();
        vm.startPrank(trader);
        usdc.approve(address(headline), 100 * U);
        headline.submitBuy(true, 100 * U, 1, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
        vm.warp(headline.epochEndsAt(buyEpoch) + 11);
        address[] memory one = new address[](1);
        one[0] = address(headline);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = buyEpoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, one, epochs);
        room.processRoom(one, epochs, type(uint256).max);
        assertGt(headline.positionAOf(trader), 0, "the trader holds a real position");

        // The gate key is lost here. Nothing more is ever signed.
        uint256 stallStart = block.timestamp;

        // Before the timeout, the room stays open: recovery must not be a
        // shortcut around a merely slow gate.
        vm.warp(stallStart + STALL_TIMEOUT - 1);
        vm.prank(keeper);
        vm.expectRevert(LiveRoom.TooEarly.selector);
        room.closeRoomOnGateStall();

        // After the frozen stall timeout, anyone can close the room.
        vm.warp(stallStart + STALL_TIMEOUT + 1);
        vm.prank(keeper);
        room.closeRoomOnGateStall();
        assertGt(room.roomClosedSequence(), 0, "the room closed without the gate");

        vm.prank(keeper);
        room.closeRemainingSlots(one);
        assertEq(uint256(headline.gateState()), 2, "the market closed");

        // Resolution then follows its normal fail-closed path.
        vm.warp(headline.resolutionDueAt() + 1);
        headline.invalidateUnresolved();
        assertEq(uint256(headline.finalOutcome()), 4, "unresolvable becomes Invalid");

        // Everyone's money comes back.
        uint256 traderBefore = usdc.balanceOf(trader);
        vm.prank(trader);
        headline.redeemPositions();
        assertGt(usdc.balanceOf(trader), traderBefore, "positions redeem");

        uint256 lpBefore = usdc.balanceOf(lp);
        vm.prank(lp);
        headline.settleLpInventory();
        assertGt(usdc.balanceOf(lp), lpBefore, "LP inventory settles");

        vm.warp(uint256(room.roomClosedAt()) + room.integrityClaimWindow() + 1);
        uint256 bondBefore = usdc.balanceOf(participantA);
        vm.prank(participantA);
        room.claimIntegrityBond();
        assertEq(usdc.balanceOf(participantA), bondBefore + 100 * U, "the bond releases");
        vm.prank(participantB);
        room.claimIntegrityBond();
        assertEq(usdc.balanceOf(address(room)), 0, "the room retains nothing");
    }

    /// The same protection must exist before any slot is published: two bonds
    /// are already at risk the moment a room is armed.
    function testBondsAreRecoverableEvenIfNoSlotWasEverPublished() public {
        vm.warp(block.timestamp + STALL_TIMEOUT + 1);
        vm.prank(keeper);
        room.closeRoomOnGateStall();

        vm.warp(uint256(room.roomClosedAt()) + room.integrityClaimWindow() + 1);
        vm.prank(participantA);
        room.claimIntegrityBond();
        vm.prank(participantB);
        room.claimIntegrityBond();
        assertEq(usdc.balanceOf(address(room)), 0, "an empty stalled room still returns its bonds");
    }

    /// Any gate action resets the stall clock: a live gate is never at risk of
    /// having its room closed out from under it.
    function testGateActivityResetsTheStallClock() public {
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline, 1_000 * U);

        vm.warp(block.timestamp + STALL_TIMEOUT - 10);
        // A single gate action keeps the room alive.
        vm.prank(gateSigner);
        room.suspendRoom(seq++);

        vm.warp(block.timestamp + 20); // past the ORIGINAL deadline, not the new one
        vm.prank(keeper);
        vm.expectRevert(LiveRoom.TooEarly.selector);
        room.closeRoomOnGateStall();

        vm.warp(block.timestamp + STALL_TIMEOUT);
        vm.prank(keeper);
        room.closeRoomOnGateStall();
        assertGt(room.roomClosedSequence(), 0);
    }

    /// A stall close must not be usable twice, and the gate cannot act after it.
    function testStallCloseIsIrreversibleAndFinal() public {
        vm.warp(block.timestamp + STALL_TIMEOUT + 1);
        room.closeRoomOnGateStall();

        vm.expectRevert(LiveRoom.RoomIsClosed.selector);
        room.closeRoomOnGateStall();

        vm.prank(gateSigner);
        vm.expectRevert(LiveRoom.RoomIsClosed.selector);
        room.suspendRoom(seq++);
    }

    /// The stall close must produce a sequence every market will accept, or the
    /// slots could not be closed and the recovery would be theatre.
    function testStallCloseSequenceExceedsEveryMarketWatermark() public {
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline, 1_000 * U);
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro?");

        uint256 observed = room.lastObservedSequence();
        vm.warp(block.timestamp + STALL_TIMEOUT + 1);
        room.closeRoomOnGateStall();
        assertGt(room.roomClosedSequence(), observed, "past the room watermark");
        assertGt(room.roomClosedSequence(), headline.lastSafeSequence(), "past the headline watermark");

        address[] memory markets = new address[](2);
        markets[0] = address(headline);
        markets[1] = address(micro);
        room.closeRemainingSlots(markets);
        assertEq(uint256(headline.gateState()), 2);
        assertEq(uint256(micro.gateState()), 2);
    }
}
