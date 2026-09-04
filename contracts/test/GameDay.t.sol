// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {RoomLiquidityCommitments} from "../src/RoomLiquidityCommitments.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Game day: one complete Live Room on a real EVM — one headline market plus
/// three sequential micro markets, publication permits, source gating,
/// suspension and recovery, a decisive close, refunds, resolution with a
/// challenge and an invalidation, LP commitments, claims, room bond release,
/// and permissionless recovery paths.
contract GameDayTest is Test {
    uint256 private constant U = 1e6;
    bytes32 private constant TPL_HEADLINE = bytes32("tpl-participant-v1");
    bytes32 private constant TPL_THRESHOLD = bytes32("tpl-threshold-v1");
    bytes32 private constant TPL_RACE = bytes32("tpl-race-v1");

    MockUSDC internal usdc;
    LiveMarketFactory internal factory;
    LiveRoom internal room;
    RoomLiquidityCommitments internal commitments;

    uint256 internal gatePk = 0xA11CE;
    uint256 internal lpPk = 0xB0B;
    address internal gateSigner;
    address internal lp;
    address internal publisher = makeAddr("publisher");
    address internal adjudicator = makeAddr("adjudicator");
    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");
    address internal rewardA = makeAddr("rewardA");
    address internal rewardB = makeAddr("rewardB");
    address internal bondRecipient = makeAddr("bondRecipient");
    address internal resolver1 = makeAddr("resolver1");
    address internal resolver2 = makeAddr("resolver2");
    address internal resolver3 = makeAddr("resolver3");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal challenger = makeAddr("challenger");

    uint256 internal nextNonce = 1;
    uint256 internal seq = 1000;

    LivePredictionMarket internal headline;
    LivePredictionMarket[3] internal micros;

    function setUp() public {
        vm.warp(1_700_000_000);
        gateSigner = vm.addr(gatePk);
        lp = vm.addr(lpPk);
        usdc = new MockUSDC();
        factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );
        commitments = new RoomLiquidityCommitments(address(usdc));

        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](3);
        templates[0] = LiveRoom.TemplateRule({templateId: TPL_HEADLINE, winnerRewardBps: 100});
        templates[1] = LiveRoom.TemplateRule({templateId: TPL_THRESHOLD, winnerRewardBps: 0});
        templates[2] = LiveRoom.TemplateRule({templateId: TPL_RACE, winnerRewardBps: 100});

        // ADR 0023 first-template parameters.
        LiveRoom.RoomConfig memory config = LiveRoom.RoomConfig({
            roomId: bytes32("gameday"),
            headlineTemplateId: TPL_HEADLINE,
            gateSigner: gateSigner,
            publisher: publisher,
            integrityAdjudicator: adjudicator,
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: rewardA,
            rewardAddressB: rewardB,
            bondRecipient: bondRecipient,
            liquidityRouter: address(commitments),
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
            gateStallTimeout: 6 hours,
            maxOpenSlots: 2,
            participantAName: "Alice",
            participantBName: "Bob",
            templates: templates,
            restrictedWallets: new address[](0)
        });
        room = LiveRoom(factory.createRoom(config));

        _mint(participantA);
        _mint(participantB);
        _mint(lp);
        _mint(alice);
        _mint(bob);
        _mint(challenger);
        vm.prank(lp);
        usdc.approve(address(commitments), 10_000 * U);
    }

    function _mint(address account) internal {
        usdc.mint(account, 100_000 * U);
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
            streamUrl: "https://example.com/live",
            imageUrl: ""
        });
        LiveRoom.PublicationPermit memory permit = LiveRoom.PublicationPermit({
            slotIndex: uint32(room.slotCount()),
            requestHash: room.slotRequestHash(request, new address[](0)),
            conditionHash: request.conditionHash,
            undecidedThroughSequence: seq++,
            announceDelay: 30,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 2 minutes),
            nonce: nextNonce++
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(gatePk, room.permitDigest(permit));
        vm.prank(publisher);
        return LivePredictionMarket(room.publishSlot(request, permit, abi.encodePacked(r, s, v), new address[](0)));
    }

    function _clear(LivePredictionMarket[] memory markets, uint64 epoch) internal {
        uint256 readyAt = markets[0].epochEndsAt(epoch) + markets[0].sourceFinalityDelay();
        if (block.timestamp < readyAt) vm.warp(readyAt + 1);
        address[] memory addresses = new address[](markets.length);
        uint64[] memory epochs = new uint64[](markets.length);
        for (uint256 i = 0; i < markets.length; i++) {
            addresses[i] = address(markets[i]);
            epochs[i] = epoch;
        }
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, addresses, epochs);
        room.processRoom(addresses, epochs, type(uint256).max);
    }

    function _one(LivePredictionMarket market) internal pure returns (LivePredictionMarket[] memory list) {
        list = new LivePredictionMarket[](1);
        list[0] = market;
    }

    function _seed(LivePredictionMarket market, address provider, uint256 amount) internal {
        if (block.timestamp < market.opensAt()) vm.warp(market.opensAt());
        uint64 epoch = market.currentEpoch();
        vm.startPrank(provider);
        usdc.approve(address(market), amount);
        market.submitAddLiquidity(amount, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(_one(market), epoch);
    }

    function _buy(LivePredictionMarket market, address buyer, bool outcomeA, uint256 budget) internal {
        uint64 epoch = market.currentEpoch();
        vm.startPrank(buyer);
        usdc.approve(address(market), budget);
        market.submitBuy(outcomeA, budget, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(_one(market), epoch);
    }

    function _resolve(LivePredictionMarket market, LivePredictionMarket.Outcome outcome) internal {
        bytes32 evidence = keccak256(abi.encode("evidence-bundle", address(market)));
        vm.prank(resolver1);
        market.attestResult(outcome, evidence);
        vm.prank(resolver2);
        market.attestResult(outcome, evidence);
        vm.warp(block.timestamp + market.challengeWindow());
        market.finalizeUnchallenged();
    }

    /// The complete session, in order.
    function testCompleteLiveRoomSession() public {
        // 1. Arming: two bond transactions cover the whole session.
        _postBonds();
        assertTrue(room.participantsReady(), "room armed");

        // 2. The headline slot: published under a permit, with the announce delay.
        headline = _publish(TPL_HEADLINE, 100, "Who wins the entire competition?");
        assertEq(room.slotCount(), 1);
        assertEq(headline.opensAt(), uint64(block.timestamp + 30), "30s announce delay");
        assertTrue(headline.isReady(), "readiness delegated to the room");

        // Actions before the announce delay elapses are refused. Liquidity is
        // the first action possible, so it is what the delay must block.
        vm.startPrank(lp);
        usdc.approve(address(headline), 100 * U);
        vm.expectRevert(LivePredictionMarket.TooEarly.selector);
        headline.submitAddLiquidity(100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();

        // 3. First liquidity, then audience trading.
        _seed(headline, lp, 2_000 * U);
        assertTrue(headline.hasLiquidity(), "headline backed");
        _buy(headline, alice, true, 100 * U);
        assertGt(headline.positionAOf(alice), 0, "alice holds outcome A");
        assertEq(headline.winnerRewardPool(), 1 * U, "1% winner reward on a participant market");

        // 4. Micro slot 1: a threshold question, no winner reward.
        micros[0] = _publish(TPL_THRESHOLD, 0, "Will Bob's return exceed 2%?");
        _seed(micros[0], lp, 300 * U);
        _buy(micros[0], bob, false, 50 * U);
        assertEq(micros[0].winnerRewardPool(), 0, "threshold markets carry no winner reward");

        // Concurrency cap: headline + one micro is the frozen maximum.
        LiveRoom.SlotRequest memory extra = LiveRoom.SlotRequest({
            templateId: TPL_THRESHOLD,
            templateParamsHash: keccak256("x"),
            conditionHash: keccak256("y"),
            announceDelay: 30,
            winnerRewardBps: 0,
            question: "One too many",
            streamUrl: "",
            imageUrl: ""
        });
        LiveRoom.PublicationPermit memory extraPermit = LiveRoom.PublicationPermit({
            slotIndex: 2,
            requestHash: room.slotRequestHash(extra, new address[](0)),
            conditionHash: extra.conditionHash,
            undecidedThroughSequence: seq,
            announceDelay: 30,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 2 minutes),
            nonce: nextNonce
        });
        (uint8 ev, bytes32 er, bytes32 es) = vm.sign(gatePk, room.permitDigest(extraPermit));
        bytes memory extraSignature = abi.encodePacked(er, es, ev);
        address[] memory noExtra = new address[](0);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.TooManyOpenSlots.selector);
        room.publishSlot(extra, extraPermit, extraSignature, noExtra);

        // 5. A stale source suspends the room; recovery reopens it.
        vm.prank(gateSigner);
        room.suspendRoom(seq++);
        assertEq(uint256(headline.gateState()), 1, "headline suspended");
        vm.startPrank(alice);
        usdc.approve(address(headline), 10 * U);
        vm.expectRevert(LivePredictionMarket.InvalidState.selector);
        headline.submitBuy(true, 10 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        vm.prank(gateSigner);
        room.reopenRoom(seq++);
        assertEq(uint256(headline.gateState()), 0, "reopened after recovery");

        // 6. Micro slot 1's decisive event closes only that slot.
        address[] memory closeFirst = new address[](1);
        closeFirst[0] = address(micros[0]);
        vm.prank(gateSigner);
        room.closeSlots(seq++, closeFirst);
        assertEq(uint256(micros[0].gateState()), 2, "micro closed");
        assertEq(uint256(headline.gateState()), 0, "headline keeps trading");
        assertEq(room.openSlotCount(), 1);

        // 7. Micro slot 2 opens in the freed capacity, funded by an LP commitment.
        micros[1] = _publish(TPL_THRESHOLD, 0, "Will Alice clear $500 next?");
        _executeCommitment(micros[1]);
        assertTrue(micros[1].hasLiquidity(), "commitment funded the slot");
        assertEq(micros[1].lpSharesOf(lp), 200 * U, "the LP owns the position, not the router");

        // An action caught by the decisive close is refunded, not executed.
        uint64 doomedEpoch = micros[1].currentEpoch();
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.startPrank(alice);
        usdc.approve(address(micros[1]), 25 * U);
        micros[1].submitBuy(true, 25 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        address[] memory closeSecond = new address[](1);
        closeSecond[0] = address(micros[1]);
        vm.prank(gateSigner);
        room.closeSlots(seq++, closeSecond);
        micros[1].processEpoch(doomedEpoch, type(uint256).max);
        assertEq(usdc.balanceOf(alice), aliceBefore, "the overlapping epoch refunded in full");

        // 8. Micro slot 3: a race question that will end in a tie.
        micros[2] = _publish(TPL_RACE, 100, "Who reaches $10,000 profit first?");
        _seed(micros[2], lp, 300 * U);
        _buy(micros[2], bob, true, 40 * U);

        // 9. The terminal condition closes the room; a keeper finishes the job.
        uint256 terminal = seq++;
        vm.prank(gateSigner);
        room.closeRoom(terminal);
        assertEq(room.roomClosedSequence(), terminal);
        address[] memory remaining = new address[](2);
        remaining[0] = address(headline);
        remaining[1] = address(micros[2]);
        vm.prank(keeper);
        room.closeRemainingSlots(remaining);
        assertEq(room.openSlotCount(), 0, "every slot closed");

        // 10. Resolution: a clean headline, a challenged micro, and one invalid.
        _resolve(headline, LivePredictionMarket.Outcome.ParticipantA);
        _resolve(micros[0], LivePredictionMarket.Outcome.ParticipantB); // "No"
        _challengeToInvalid(micros[1]);
        _resolve(micros[2], LivePredictionMarket.Outcome.Tie);

        assertEq(uint256(headline.finalOutcome()), 1);
        assertEq(uint256(micros[0].finalOutcome()), 2);
        assertEq(uint256(micros[1].finalOutcome()), 4, "upheld challenge invalidates");
        assertEq(uint256(micros[2].finalOutcome()), 3, "race with no winner ties");

        // 11. Claims across every settled slot.
        uint256 alicePositions = headline.positionAOf(alice);
        uint256 aliceBalanceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        headline.redeemPositions();
        assertEq(usdc.balanceOf(alice), aliceBalanceBefore + alicePositions, "winning positions pay $1 each");

        uint256 rewardBefore = usdc.balanceOf(rewardA);
        vm.prank(rewardA);
        headline.claimWinnerReward();
        assertEq(usdc.balanceOf(rewardA), rewardBefore + 1 * U, "the winning participant takes the reward pool");

        // The threshold market resolved to "No" and carries no reward pool:
        // the winning side's reward address has nothing to claim.
        vm.prank(rewardB);
        vm.expectRevert(LivePredictionMarket.NothingToClaim.selector);
        micros[0].claimWinnerReward();

        vm.prank(lp);
        headline.settleLpInventory();
        vm.prank(lp);
        headline.claimLpFees();

        // Invalid market: alice holds nothing there — her buy was refunded by
        // the decisive close — so the LP's inventory is what settles, at 0.5/0.5.
        assertEq(micros[1].positionAOf(alice), 0, "the refunded buy minted no position");
        uint256 lpInvalidBefore = usdc.balanceOf(lp);
        vm.prank(lp);
        micros[1].settleLpInventory();
        assertGt(usdc.balanceOf(lp), lpInvalidBefore, "invalid market returns LP inventory");

        // Tie: both sides redeem at 0.5 and the reward splits.
        vm.prank(bob);
        micros[2].redeemPositions();
        vm.prank(rewardA);
        micros[2].claimWinnerReward();
        vm.prank(rewardB);
        micros[2].claimWinnerReward();

        // 12. Room bonds release only after everything settled.
        vm.warp(uint256(room.roomClosedAt()) + room.integrityClaimWindow());
        uint256 bondBefore = usdc.balanceOf(participantA);
        vm.prank(participantA);
        room.claimIntegrityBond();
        assertEq(usdc.balanceOf(participantA), bondBefore + 100 * U);
        vm.prank(participantB);
        room.claimIntegrityBond();
        assertEq(usdc.balanceOf(address(room)), 0, "the room retains nothing");

        // 13. Solvency across every market.
        LivePredictionMarket[4] memory all = [headline, micros[0], micros[1], micros[2]];
        for (uint256 i = 0; i < all.length; i++) {
            assertLe(
                all[i].accountedLiabilities(),
                usdc.balanceOf(address(all[i])),
                "every market stays solvent through settlement"
            );
        }
    }

    function _executeCommitment(LivePredictionMarket market) internal {
        if (block.timestamp < market.opensAt()) vm.warp(market.opensAt());
        bytes32[] memory allowed = new bytes32[](1);
        allowed[0] = TPL_THRESHOLD;
        RoomLiquidityCommitments.Commitment memory commitment = RoomLiquidityCommitments.Commitment({
            room: address(room),
            provider: lp,
            allowedTemplates: allowed,
            amountPerSlot: 200 * U,
            maxSimultaneous: 400 * U,
            maxTotal: 1_000 * U,
            expiresAt: uint64(block.timestamp + 7 days),
            nonce: 77
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lpPk, commitments.commitmentId(commitment));
        uint64 epoch = market.currentEpoch();
        vm.prank(keeper); // an unrelated address executes the LP's signed policy
        commitments.execute(commitment, abi.encodePacked(r, s, v), address(market));
        _clear(_one(market), epoch);
    }

    function _challengeToInvalid(LivePredictionMarket market) internal {
        bytes32 evidence = keccak256(abi.encode("provisional", address(market)));
        vm.prank(resolver1);
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, evidence);
        vm.prank(resolver2);
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, evidence);

        vm.startPrank(challenger);
        usdc.approve(address(market), 10 * U);
        market.challengeResult(keccak256("contradiction"), 10 * U);
        vm.stopPrank();
        vm.prank(resolver1);
        market.attestChallengeVerdict(true);
        vm.prank(resolver3);
        market.attestChallengeVerdict(true);
    }

    /// Missing gate transactions fail closed: uncleared actions refund.
    function testKillingTheGateRefundsEveryAffectedAction() public {
        _postBonds();
        headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline, lp, 1_000 * U);

        uint256 before = usdc.balanceOf(alice);
        uint64 epoch = headline.currentEpoch();
        vm.startPrank(alice);
        usdc.approve(address(headline), 100 * U);
        headline.submitBuy(true, 100 * U, 1, uint64(block.timestamp + 1 hours));
        vm.stopPrank();

        // The gate never signs again. After maxPendingTime, anyone pushes the refund.
        vm.warp(headline.epochEndsAt(epoch) + headline.maxPendingTime() + 1);
        vm.prank(keeper);
        headline.processEpoch(epoch, type(uint256).max);
        assertEq(usdc.balanceOf(alice), before, "a stalled gate refunds rather than trapping funds");
    }
}
