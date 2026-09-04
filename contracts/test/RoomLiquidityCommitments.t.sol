// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {RoomLiquidityCommitments} from "../src/RoomLiquidityCommitments.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Issue 16: room liquidity commitments. Automates the decision, not the capital.
contract RoomLiquidityCommitmentsTest is Test {
    uint256 private constant U = 1e6;
    bytes32 private constant TPL_HEADLINE = bytes32("tpl-participant-v1");
    bytes32 private constant TPL_THRESHOLD = bytes32("tpl-threshold-v1");

    MockUSDC internal usdc;
    LiveMarketFactory internal factory;
    LiveRoom internal room;
    RoomLiquidityCommitments internal commitments;

    uint256 internal gatePk = 0xA11CE;
    uint256 internal lpPk = 0xB0B;
    address internal gateSigner;
    address internal lp;
    address internal publisher = makeAddr("publisher");
    address internal executor = makeAddr("executor");
    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");
    address internal resolver1 = makeAddr("resolver1");
    address internal resolver2 = makeAddr("resolver2");
    address internal resolver3 = makeAddr("resolver3");

    uint256 internal nextNonce = 1;
    uint256 internal seq = 1000;

    function setUp() public {
        gateSigner = vm.addr(gatePk);
        lp = vm.addr(lpPk);
        usdc = new MockUSDC();
        factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );
        commitments = new RoomLiquidityCommitments(address(usdc));

        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](2);
        templates[0] = LiveRoom.TemplateRule({templateId: TPL_HEADLINE, winnerRewardBps: 100});
        templates[1] = LiveRoom.TemplateRule({templateId: TPL_THRESHOLD, winnerRewardBps: 0});

        LiveRoom.RoomConfig memory config = LiveRoom.RoomConfig({
            roomId: bytes32("room-lp"),
            headlineTemplateId: TPL_HEADLINE,
            gateSigner: gateSigner,
            publisher: publisher,
            integrityAdjudicator: makeAddr("adjudicator"),
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
            bondRecipient: makeAddr("bondRecipient"),
            liquidityRouter: address(commitments),
            resolvers: [resolver1, resolver2, resolver3],
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
            maxOpenSlots: 6,
            participantAName: "Nova",
            participantBName: "Arc",
            templates: templates,
            restrictedWallets: new address[](0)
        });
        room = LiveRoom(factory.createRoom(config));

        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        usdc.mint(lp, 100_000 * U);
        vm.startPrank(participantA);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();

        // One bounded approval to one known address.
        vm.prank(lp);
        usdc.approve(address(commitments), 10_000 * U);
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

    function _clear(LivePredictionMarket market, uint64 epoch) internal {
        vm.warp(market.epochEndsAt(epoch) + 6);
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);
        room.processRoom(markets, epochs, type(uint256).max);
    }

    function _headlineBacked() internal returns (LivePredictionMarket headline) {
        headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        vm.warp(headline.opensAt());
        uint64 epoch = headline.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(headline), 1_000 * U);
        headline.submitAddLiquidity(1_000 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(headline, epoch);
    }

    function _commitment(uint256 perSlot, uint256 maxSimultaneous, uint256 maxTotal)
        internal
        view
        returns (RoomLiquidityCommitments.Commitment memory commitment)
    {
        bytes32[] memory allowed = new bytes32[](1);
        allowed[0] = TPL_THRESHOLD;
        commitment = RoomLiquidityCommitments.Commitment({
            room: address(room),
            provider: lp,
            allowedTemplates: allowed,
            amountPerSlot: perSlot,
            maxSimultaneous: maxSimultaneous,
            maxTotal: maxTotal,
            expiresAt: uint64(block.timestamp + 7 days),
            nonce: 1
        });
    }

    function _sign(RoomLiquidityCommitments.Commitment memory commitment) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lpPk, commitments.commitmentId(commitment));
        return abi.encodePacked(r, s, v);
    }

    function _settle(LivePredictionMarket market, LivePredictionMarket.Outcome outcome) internal {
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        vm.prank(gateSigner);
        room.closeSlots(seq++, markets);
        bytes32 evidence = keccak256(abi.encode("evidence", address(market)));
        vm.prank(resolver1);
        market.attestResult(outcome, evidence);
        vm.prank(resolver2);
        market.attestResult(outcome, evidence);
        vm.warp(block.timestamp + market.challengeWindow());
        market.finalizeUnchallenged();
    }

    function testOneApprovalOneSignatureSuppliesALaterSlot() public {
        _headlineBacked();
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro 1");
        vm.warp(micro.opensAt());

        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 300 * U, 1_000 * U);
        bytes memory signature = _sign(commitment);

        uint64 epoch = micro.currentEpoch();
        vm.prank(executor); // an unrelated address executes
        commitments.execute(commitment, signature, address(micro));
        _clear(micro, epoch);

        assertEq(micro.lpSharesOf(lp), 100 * U, "the LP receives that slot's position");
        assertEq(micro.lpSharesOf(executor), 0, "the executor earns nothing");
        assertEq(micro.lpSharesOf(address(commitments)), 0, "the router holds nothing");
        assertEq(usdc.balanceOf(address(commitments)), 0, "no balance retained between transactions");
    }

    function testExposureCapBlocksUntilASettledSlotIsReleased() public {
        _headlineBacked();
        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 200 * U, 1_000 * U);
        bytes memory signature = _sign(commitment);

        LivePredictionMarket first = _publish(TPL_THRESHOLD, 0, "Micro 1");
        LivePredictionMarket second = _publish(TPL_THRESHOLD, 0, "Micro 2");
        LivePredictionMarket third = _publish(TPL_THRESHOLD, 0, "Micro 3");
        vm.warp(third.opensAt());

        commitments.execute(commitment, signature, address(first));
        commitments.execute(commitment, signature, address(second));

        // Cap of two concurrent slots reached.
        vm.expectRevert(RoomLiquidityCommitments.ExposureExceeded.selector);
        commitments.execute(commitment, signature, address(third));

        // Releasing before settlement is refused.
        bytes32 id = commitments.commitmentId(commitment);
        vm.expectRevert(RoomLiquidityCommitments.NotSettled.selector);
        commitments.releaseExposure(commitment, address(first));

        _clear(first, first.currentEpoch());
        _settle(first, LivePredictionMarket.Outcome.ParticipantA);

        // Permissionless release restores headroom, exactly once.
        vm.prank(executor);
        commitments.releaseExposure(commitment, address(first));
        assertEq(commitments.activeExposure(id), 100 * U);
        vm.expectRevert(RoomLiquidityCommitments.NothingToRelease.selector);
        commitments.releaseExposure(commitment, address(first));

        // Slot N+1 now executes.
        commitments.execute(commitment, signature, address(third));
        assertEq(commitments.totalExecuted(id), 300 * U);
        assertEq(usdc.balanceOf(address(commitments)), 0);
    }

    function testDoubleExecutionAgainstOneSlotIsStructurallyImpossible() public {
        _headlineBacked();
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro 1");
        vm.warp(micro.opensAt());
        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 500 * U, 1_000 * U);
        bytes memory signature = _sign(commitment);

        commitments.execute(commitment, signature, address(micro));
        vm.expectRevert(RoomLiquidityCommitments.AlreadyExecuted.selector);
        commitments.execute(commitment, signature, address(micro));
    }

    function testTotalCapEnforced() public {
        _headlineBacked();
        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 1_000 * U, 150 * U);
        bytes memory signature = _sign(commitment);
        LivePredictionMarket first = _publish(TPL_THRESHOLD, 0, "Micro 1");
        LivePredictionMarket second = _publish(TPL_THRESHOLD, 0, "Micro 2");
        vm.warp(second.opensAt());

        commitments.execute(commitment, signature, address(first));
        vm.expectRevert(RoomLiquidityCommitments.TotalExceeded.selector);
        commitments.execute(commitment, signature, address(second));
    }

    function testTemplateOutsideThePolicyIsRejected() public {
        LivePredictionMarket headline = _headlineBacked();
        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 500 * U, 1_000 * U);
        bytes memory signature = _sign(commitment);
        // The headline uses TPL_HEADLINE, which the policy does not allow.
        vm.expectRevert(RoomLiquidityCommitments.TemplateNotAllowed.selector);
        commitments.execute(commitment, signature, address(headline));
    }

    function testExpiredCancelledAndForgedCommitmentsCannotExecute() public {
        _headlineBacked();
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro 1");
        vm.warp(micro.opensAt());

        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 500 * U, 1_000 * U);
        bytes memory signature = _sign(commitment);

        // Forged signature from another key.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xBADF00D), commitments.commitmentId(commitment));
        bytes memory forged = abi.encodePacked(r, s, v);
        vm.expectRevert(RoomLiquidityCommitments.InvalidSignature.selector);
        commitments.execute(commitment, forged, address(micro));

        // Cancelled by the LP.
        vm.prank(lp);
        commitments.cancel(commitment.nonce);
        vm.expectRevert(RoomLiquidityCommitments.CommitmentCancelledError.selector);
        commitments.execute(commitment, signature, address(micro));

        // Expired. (Sign before arming expectRevert: commitmentId is an
        // external staticcall and would consume the expectation.)
        RoomLiquidityCommitments.Commitment memory expired = _commitment(100 * U, 500 * U, 1_000 * U);
        expired.nonce = 2;
        expired.expiresAt = uint64(block.timestamp);
        bytes memory expiredSignature = _sign(expired);
        vm.expectRevert(RoomLiquidityCommitments.CommitmentExpired.selector);
        commitments.execute(expired, expiredSignature, address(micro));
    }

    function testUnknownMarketRejected() public {
        _headlineBacked();
        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 500 * U, 1_000 * U);
        bytes memory signature = _sign(commitment);
        address stranger = makeAddr("not-a-slot");
        vm.expectRevert(RoomLiquidityCommitments.UnknownSlot.selector);
        commitments.execute(commitment, signature, stranger);
    }

    function testRefundOnFailedMinimumReturnsToTheLp() public {
        _headlineBacked();
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro 1");
        vm.warp(micro.opensAt());
        RoomLiquidityCommitments.Commitment memory commitment = _commitment(100 * U, 500 * U, 1_000 * U);
        bytes memory signature = _sign(commitment);

        uint256 lpBefore = usdc.balanceOf(lp);
        uint64 epoch = micro.currentEpoch();
        commitments.execute(commitment, signature, address(micro));
        assertEq(usdc.balanceOf(lp), lpBefore - 100 * U, "the LP funded the escrow");

        // Never cleared: the epoch times out and refunds.
        vm.warp(micro.epochEndsAt(epoch) + micro.maxPendingTime() + 1);
        micro.processEpoch(epoch, type(uint256).max);
        assertEq(usdc.balanceOf(lp), lpBefore, "the refund lands on the LP, not the router");
        assertEq(usdc.balanceOf(address(commitments)), 0);
    }
}
