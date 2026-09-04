// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Issue 02: the LiveRoom contract — Publication Permits, batched gating with
/// isolated failure, room-held Integrity Bonds, and permissionless recovery.
contract LiveRoomTest is Test {
    uint256 private constant U = 1e6;
    bytes32 private constant TPL_HEADLINE = bytes32("tpl-participant-v1");
    bytes32 private constant TPL_THRESHOLD = bytes32("tpl-threshold-v1");

    MockUSDC internal usdc;
    LiveMarketFactory internal factory;
    LiveRoom internal room;

    uint256 internal gatePk = 0xA11CE;
    address internal gateSigner;
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
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");
    address internal keeper = makeAddr("keeper");

    uint256 internal nextNonce = 1;
    uint256 internal seq = 1000;

    function setUp() public {
        gateSigner = vm.addr(gatePk);
        usdc = new MockUSDC();
        LivePredictionMarket marketImplementation = new LivePredictionMarket();
        LiveRoom roomImplementation = new LiveRoom();
        factory = new LiveMarketFactory(
            address(usdc), address(this), address(marketImplementation), address(roomImplementation)
        );

        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](2);
        templates[0] = LiveRoom.TemplateRule({templateId: TPL_HEADLINE, winnerRewardBps: 100});
        templates[1] = LiveRoom.TemplateRule({templateId: TPL_THRESHOLD, winnerRewardBps: 0});

        address[] memory insiders = new address[](1);
        insiders[0] = makeAddr("insider");

        LiveRoom.RoomConfig memory config = LiveRoom.RoomConfig({
            roomId: bytes32("room-1"),
            headlineTemplateId: TPL_HEADLINE,
            gateSigner: gateSigner,
            publisher: publisher,
            integrityAdjudicator: adjudicator,
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: rewardA,
            rewardAddressB: rewardB,
            bondRecipient: bondRecipient,
            liquidityRouter: address(0),
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
            maxOpenSlots: 4,
            participantAName: "Nova",
            participantBName: "Arc",
            templates: templates,
            restrictedWallets: insiders
        });
        room = LiveRoom(factory.createRoom(config));

        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        usdc.mint(lp, 100_000 * U);
        usdc.mint(trader, 100_000 * U);
        usdc.mint(keeper, 1_000 * U);
        _postRoomBonds();
    }

    function _postRoomBonds() internal {
        vm.startPrank(participantA);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
    }

    function _request(bytes32 templateId, uint16 bps, string memory question)
        internal
        pure
        returns (LiveRoom.SlotRequest memory)
    {
        return LiveRoom.SlotRequest({
            templateId: templateId,
            templateParamsHash: keccak256(abi.encode(templateId, question)),
            conditionHash: keccak256(abi.encode("condition", question)),
            announceDelay: 30,
            winnerRewardBps: bps,
            question: question,
            streamUrl: "https://example.com/live",
            imageUrl: ""
        });
    }

    function _permit(LiveRoom.SlotRequest memory request, uint32 slotIndex, uint256 undecidedThrough)
        internal
        returns (LiveRoom.PublicationPermit memory)
    {
        return LiveRoom.PublicationPermit({
            slotIndex: slotIndex,
            requestHash: room.slotRequestHash(request, new address[](0)),
            conditionHash: request.conditionHash,
            undecidedThroughSequence: undecidedThrough,
            announceDelay: request.announceDelay,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 2 minutes),
            nonce: nextNonce++
        });
    }

    function _sign(uint256 pk, LiveRoom.PublicationPermit memory permit) internal view returns (bytes memory) {
        bytes32 digest = room.permitDigest(permit);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _publish(bytes32 templateId, uint16 bps, string memory question) internal returns (LivePredictionMarket) {
        LiveRoom.SlotRequest memory request = _request(templateId, bps, question);
        LiveRoom.PublicationPermit memory permit = _permit(request, uint32(room.slotCount()), seq++);
        bytes memory signature = _sign(gatePk, permit);
        address[] memory extra = new address[](0);
        vm.prank(publisher);
        return LivePredictionMarket(room.publishSlot(request, permit, signature, extra));
    }

    function _publishHeadline() internal returns (LivePredictionMarket) {
        return _publish(TPL_HEADLINE, 100, "Who wins the entire competition?");
    }

    function _seedSlot(LivePredictionMarket market, uint256 amount) internal {
        vm.warp(market.opensAt());
        uint64 epoch = market.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(market), amount);
        market.submitAddLiquidity(amount, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clearEpoch(market, epoch);
    }

    function _clearEpoch(LivePredictionMarket market, uint64 epoch) internal {
        uint256 readyAt = market.epochEndsAt(epoch) + market.sourceFinalityDelay();
        if (block.timestamp < readyAt) vm.warp(readyAt);
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);
        room.processRoom(markets, epochs, type(uint256).max);
    }

    // ------------------------------------------------ closing at the watermark

    /// A decisive event that lands on the sequence an epoch just cleared at.
    ///
    /// The room accepts it — `_advanceSequence` only rejects a REGRESSION — and
    /// writes `roomClosedSequence` irreversibly. Every market then rejects
    /// `closeForDecisiveEvent` at that same sequence, because a market requires
    /// one strictly above its own watermark, and the room swallows the failure
    /// as a skip. The slot stays Open with no way to close it: `closeSlots` and
    /// `closeRoomOnGateStall` both revert on a closed room, and
    /// `closeRemainingSlots` can only ever replay the sequence that is already
    /// failing. Positions, LP inventory and the room's Integrity Bonds are all
    /// stranded behind a market that can never resolve.
    function testClosingOnTheWatermarkStillClosesEverySlot() public {
        LivePredictionMarket market = _publishHeadline();
        _seedSlot(market, 1_000e6);

        // The sequence the last epoch cleared at is now both the room's
        // watermark and the market's.
        uint256 watermark = room.lastObservedSequence();
        assertEq(market.lastSafeSequence(), watermark, "the market cleared at the room's watermark");

        vm.prank(gateSigner);
        room.closeRoom(watermark);

        address[] memory markets = new address[](1);
        markets[0] = address(market);
        room.closeRemainingSlots(markets);

        assertEq(
            uint8(market.gateState()),
            uint8(LivePredictionMarket.GateState.Closed),
            "a closed room must be able to close its slots"
        );
    }

    /// The same rule the stall path already establishes: whatever sequence the
    /// room closes at, it is one every market will accept.
    function testRoomClosesAboveEveryMarketWatermark() public {
        LivePredictionMarket market = _publishHeadline();
        _seedSlot(market, 1_000e6);
        uint256 watermark = room.lastObservedSequence();

        vm.prank(gateSigner);
        room.closeRoom(watermark);
        assertGt(room.roomClosedSequence(), market.lastSafeSequence(), "closing sequence clears every market");
    }

    // ---------------------------------------------------------------- publication

    function testPublishHappyPathBindsAndAdvancesSequence() public {
        uint256 attested = seq;
        LivePredictionMarket market = _publishHeadline();

        assertEq(room.slotCount(), 1);
        assertEq(room.slotAt(0), address(market));
        assertEq(room.lastObservedSequence(), attested, "watermark advances to the permit sequence");
        (bytes32 roomId, uint32 slotIndex,,, uint16 bps) = market.slotBinding();
        assertEq(roomId, bytes32("room-1"));
        assertEq(slotIndex, 0);
        assertEq(bps, 100);
        assertEq(market.opensAt(), uint64(block.timestamp + 30), "announce delay enforced on chain");
        assertEq(market.readinessSource(), address(room));
        assertTrue(market.isReady(), "room bonds make the slot ready");
        assertTrue(market.restrictedWallet(publisher));
        assertTrue(market.restrictedWallet(gateSigner));
        assertTrue(market.restrictedWallet(makeAddr("insider")));
    }

    function testAnnounceDelayBlocksEarlyActions() public {
        LivePredictionMarket market = _publishHeadline();
        vm.startPrank(lp);
        usdc.approve(address(market), 100 * U);
        vm.expectRevert(LivePredictionMarket.TooEarly.selector);
        market.submitAddLiquidity(100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function testPublishRejectsEachPermitDefect() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Q");
        address[] memory extra = new address[](0);

        // Non-publisher caller.
        LiveRoom.PublicationPermit memory permit = _permit(request, 0, seq);
        bytes memory signature = _sign(gatePk, permit);
        vm.expectRevert(LiveRoom.NotAuthorized.selector);
        room.publishSlot(request, permit, signature, extra);

        // Gate signer cannot publish either: the two authorities are distinct.
        vm.prank(gateSigner);
        vm.expectRevert(LiveRoom.NotAuthorized.selector);
        room.publishSlot(request, permit, signature, extra);

        // Wrong signer (publisher self-signs).
        bytes memory badSignature = _sign(0xBEEF, permit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitInvalidSigner.selector);
        room.publishSlot(request, permit, badSignature, extra);

        // Expired.
        LiveRoom.PublicationPermit memory expired = _permit(request, 0, seq);
        expired.expiresAt = uint64(block.timestamp - 1);
        bytes memory sig_expired = _sign(gatePk, expired);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitExpired.selector);
        room.publishSlot(request, expired, sig_expired, extra);

        // Longer-lived than MAX_PERMIT_LIFETIME: a stale attestation must not be usable.
        LiveRoom.PublicationPermit memory longLived = _permit(request, 0, seq);
        longLived.expiresAt = uint64(longLived.issuedAt + 6 minutes);
        bytes memory sig_longLived = _sign(gatePk, longLived);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitTooLongLived.selector);
        room.publishSlot(request, longLived, sig_longLived, extra);

        // Bound-field mismatches: request hash, condition hash, announce delay, slot index.
        LiveRoom.PublicationPermit memory wrongParams = _permit(request, 0, seq);
        wrongParams.requestHash = keccak256("other");
        bytes memory sig_wrongParams = _sign(gatePk, wrongParams);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(request, wrongParams, sig_wrongParams, extra);

        LiveRoom.PublicationPermit memory wrongCondition = _permit(request, 0, seq);
        wrongCondition.conditionHash = keccak256("other");
        bytes memory sig_wrongCondition = _sign(gatePk, wrongCondition);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(request, wrongCondition, sig_wrongCondition, extra);

        LiveRoom.PublicationPermit memory wrongDelay = _permit(request, 0, seq);
        wrongDelay.announceDelay = 31;
        bytes memory sig_wrongDelay = _sign(gatePk, wrongDelay);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(request, wrongDelay, sig_wrongDelay, extra);

        LiveRoom.PublicationPermit memory wrongIndex = _permit(request, 3, seq);
        bytes memory sig_wrongIndex = _sign(gatePk, wrongIndex);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.SlotIndexMismatch.selector);
        room.publishSlot(request, wrongIndex, sig_wrongIndex, extra);
    }

    function testPublishRejectsReplayedNonceAndStaleSequence() public {
        _publishHeadline();
        LiveRoom.SlotRequest memory request = _request(TPL_THRESHOLD, 0, "Will Bob's return exceed 2%?");
        address[] memory extra = new address[](0);

        // Stale sequence: below the watermark the headline publication just set.
        LiveRoom.PublicationPermit memory stale = _permit(request, 1, room.lastObservedSequence() - 1);
        bytes memory sig_stale = _sign(gatePk, stale);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.StaleAttestation.selector);
        room.publishSlot(request, stale, sig_stale, extra);

        // Replayed nonce.
        _seedSlot(LivePredictionMarket(room.slotAt(0)), 1_000 * U);
        LiveRoom.PublicationPermit memory permit = _permit(request, 1, seq++);
        bytes memory signature = _sign(gatePk, permit);
        vm.prank(publisher);
        room.publishSlot(request, permit, signature, extra);

        LiveRoom.SlotRequest memory request2 = _request(TPL_THRESHOLD, 0, "Another?");
        LiveRoom.PublicationPermit memory replay = _permit(request2, 2, seq++);
        replay.nonce = permit.nonce;
        bytes memory sig_replay = _sign(gatePk, replay);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitReplayed.selector);
        room.publishSlot(request2, replay, sig_replay, extra);
    }

    function testPublishRejectsCatalogAndCapAndHeadlineRules() public {
        address[] memory extra = new address[](0);

        // Slot 0 must use the headline template: a micro question cannot be first.
        LiveRoom.SlotRequest memory early = _request(TPL_THRESHOLD, 0, "Too early micro");
        LiveRoom.PublicationPermit memory earlyPermit = _permit(early, 0, seq++);
        bytes memory sig_earlyPermit = _sign(gatePk, earlyPermit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.NotHeadlineTemplate.selector);
        room.publishSlot(early, earlyPermit, sig_earlyPermit, extra);

        LivePredictionMarket headline = _publishHeadline();

        // Micro slot while the headline has no liquidity.
        LiveRoom.SlotRequest memory unbacked = _request(TPL_THRESHOLD, 0, "Micro before backing");
        LiveRoom.PublicationPermit memory unbackedPermit = _permit(unbacked, 1, seq++);
        bytes memory sig_unbackedPermit = _sign(gatePk, unbackedPermit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.HeadlineUnbacked.selector);
        room.publishSlot(unbacked, unbackedPermit, sig_unbackedPermit, extra);

        _seedSlot(headline, 1_000 * U);

        // Out-of-catalog template.
        LiveRoom.SlotRequest memory unknown = _request(bytes32("tpl-unknown"), 0, "Unknown");
        LiveRoom.PublicationPermit memory unknownPermit = _permit(unknown, 1, seq++);
        bytes memory sig_unknownPermit = _sign(gatePk, unknownPermit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.TemplateNotApproved.selector);
        room.publishSlot(unknown, unknownPermit, sig_unknownPermit, extra);

        // Wrong reward for the shape: threshold template must carry 0 bps.
        LiveRoom.SlotRequest memory wrongBps = _request(TPL_THRESHOLD, 100, "Threshold with reward");
        LiveRoom.PublicationPermit memory wrongBpsPermit = _permit(wrongBps, 1, seq++);
        bytes memory sig_wrongBpsPermit = _sign(gatePk, wrongBpsPermit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.TemplateNotApproved.selector);
        room.publishSlot(wrongBps, wrongBpsPermit, sig_wrongBpsPermit, extra);

        // Announce delay below the frozen minimum.
        LiveRoom.SlotRequest memory shortDelay = _request(TPL_THRESHOLD, 0, "Short delay");
        shortDelay.announceDelay = 29;
        LiveRoom.PublicationPermit memory shortDelayPermit = _permit(shortDelay, 1, seq++);
        bytes memory sig_shortDelayPermit = _sign(gatePk, shortDelayPermit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.AnnounceDelayTooShort.selector);
        room.publishSlot(shortDelay, shortDelayPermit, sig_shortDelayPermit, extra);

        // Concurrency cap: maxOpenSlots is 4.
        for (uint256 i = 0; i < 3; i++) {
            _publish(TPL_THRESHOLD, 0, string(abi.encodePacked("Micro ", vm.toString(i))));
        }
        LiveRoom.SlotRequest memory over = _request(TPL_THRESHOLD, 0, "One too many");
        LiveRoom.PublicationPermit memory overPermit = _permit(over, 4, seq++);
        bytes memory sig_overPermit = _sign(gatePk, overPermit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.TooManyOpenSlots.selector);
        room.publishSlot(over, overPermit, sig_overPermit, extra);
    }

    // ---------------------------------------------------------------- batched gating

    function testOneBatchClearsEpochsForFourSlots() public {
        LivePredictionMarket headline = _publishHeadline();
        _seedSlot(headline, 1_000 * U);
        LivePredictionMarket m1 = _publish(TPL_THRESHOLD, 0, "Micro 1");
        LivePredictionMarket m2 = _publish(TPL_THRESHOLD, 0, "Micro 2");
        LivePredictionMarket m3 = _publish(TPL_THRESHOLD, 0, "Micro 3");
        LivePredictionMarket[3] memory micros = [m1, m2, m3];

        vm.warp(m3.opensAt());
        uint64 epoch = headline.currentEpoch();
        for (uint256 i = 0; i < micros.length; i++) {
            vm.startPrank(lp);
            usdc.approve(address(micros[i]), 100 * U);
            micros[i].submitAddLiquidity(100 * U, 1, uint64(block.timestamp + 10 minutes));
            vm.stopPrank();
        }
        vm.startPrank(trader);
        usdc.approve(address(headline), 100 * U);
        headline.submitBuy(true, 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();

        vm.warp(headline.epochEndsAt(epoch) + 6);
        address[] memory markets = new address[](4);
        uint64[] memory epochs = new uint64[](4);
        markets[0] = address(headline);
        markets[1] = address(m1);
        markets[2] = address(m2);
        markets[3] = address(m3);
        for (uint256 i = 0; i < 4; i++) {
            epochs[i] = epoch;
        }
        uint256 gasBefore = gasleft();
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);
        emit log_named_uint("gas: four-slot markRoomEpochsSafe", gasBefore - gasleft());

        room.processRoom(markets, epochs, type(uint256).max);
        assertGt(headline.positionAOf(trader), 0, "headline buy executed");
        for (uint256 i = 0; i < micros.length; i++) {
            assertTrue(micros[i].hasLiquidity(), "micro liquidity executed");
        }
    }

    function testBatchIsolatesFailingChildAndAllowsRetryAtSameSequence() public {
        LivePredictionMarket headline = _publishHeadline();
        _seedSlot(headline, 1_000 * U);
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro");
        vm.warp(micro.opensAt());

        uint64 epoch = headline.currentEpoch();
        vm.startPrank(trader);
        usdc.approve(address(headline), 100 * U);
        headline.submitBuy(true, 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();

        vm.warp(headline.epochEndsAt(epoch) + 6);
        address[] memory markets = new address[](2);
        uint64[] memory epochs = new uint64[](2);
        markets[0] = address(headline);
        epochs[0] = epoch;
        markets[1] = address(micro);
        epochs[1] = epoch + 1000; // future epoch: the child reverts TooEarly and must be skipped
        uint256 usedSeq = seq++;

        vm.expectEmit(true, true, false, false, address(room));
        emit LiveRoom.SlotCallSkipped(address(micro), epoch + 1000, bytes4(0), "");
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(usedSeq, markets, epochs);

        assertTrue(headline.epochSafe(epoch), "healthy sibling cleared");
        assertFalse(micro.epochSafe(epoch), "failed child skipped, not cleared");

        // Retry the skipped market individually at the SAME room sequence.
        address[] memory retryMarkets = new address[](1);
        uint64[] memory retryEpochs = new uint64[](1);
        retryMarkets[0] = address(micro);
        retryEpochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(usedSeq, retryMarkets, retryEpochs);
        assertTrue(micro.epochSafe(epoch), "retry at the same room sequence succeeds");
    }

    function testBatchCallerErrorsRevert() public {
        LivePredictionMarket headline = _publishHeadline();
        address[] memory markets = new address[](1);
        uint64[] memory epochs = new uint64[](2);
        markets[0] = address(headline);

        vm.prank(gateSigner);
        vm.expectRevert(LiveRoom.LengthMismatch.selector);
        room.markRoomEpochsSafe(seq, markets, epochs);

        uint64[] memory oneEpoch = new uint64[](1);
        address[] memory unknown = new address[](1);
        unknown[0] = makeAddr("not-a-slot");
        vm.prank(gateSigner);
        vm.expectRevert(LiveRoom.UnknownMarket.selector);
        room.markRoomEpochsSafe(seq, unknown, oneEpoch);

        // Decreasing sequence.
        vm.prank(gateSigner);
        room.suspendRoom(seq);
        vm.prank(gateSigner);
        vm.expectRevert(LiveRoom.SequenceRegression.selector);
        room.reopenRoom(seq - 1);

        // Batch too large.
        address[] memory big = new address[](17);
        uint64[] memory bigEpochs = new uint64[](17);
        for (uint256 i = 0; i < 17; i++) {
            big[i] = address(headline);
        }
        vm.prank(gateSigner);
        vm.expectRevert(LiveRoom.BatchTooLarge.selector);
        room.markRoomEpochsSafe(seq + 1, big, bigEpochs);

        // Non-gate caller.
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.NotAuthorized.selector);
        room.suspendRoom(seq + 1);
    }

    // ---------------------------------------------------------------- close semantics

    function testMicroDecisiveEventClosesOnlyThatSlot() public {
        LivePredictionMarket headline = _publishHeadline();
        _seedSlot(headline, 1_000 * U);
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro");
        vm.warp(micro.opensAt());

        address[] memory targets = new address[](1);
        targets[0] = address(micro);
        vm.prank(gateSigner);
        room.closeSlots(seq++, targets);

        assertEq(uint256(micro.gateState()), uint256(LivePredictionMarket.GateState.Closed));
        assertEq(uint256(headline.gateState()), uint256(LivePredictionMarket.GateState.Open));
        assertEq(room.openSlotCount(), 1, "headline stays open");

        // Headline keeps trading after the micro slot closed.
        uint64 epoch = headline.currentEpoch();
        vm.startPrank(trader);
        usdc.approve(address(headline), 50 * U);
        headline.submitBuy(true, 50 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clearEpoch(headline, epoch);
        assertGt(headline.positionAOf(trader), 0);
    }

    function testCloseRoomThenPermissionlessCloseRemaining() public {
        LivePredictionMarket headline = _publishHeadline();
        _seedSlot(headline, 1_000 * U);
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro");
        vm.warp(micro.opensAt());

        uint256 terminal = seq++;
        vm.prank(gateSigner);
        room.closeRoom(terminal);
        assertEq(room.roomClosedSequence(), terminal);

        // Publication after closeRoom is rejected.
        LiveRoom.SlotRequest memory late = _request(TPL_THRESHOLD, 0, "Late");
        LiveRoom.PublicationPermit memory latePermit = _permit(late, 2, seq++);
        address[] memory extra = new address[](0);
        bytes memory sig_latePermit = _sign(gatePk, latePermit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.RoomIsClosed.selector);
        room.publishSlot(late, latePermit, sig_latePermit, extra);

        // Gate calls after closeRoom are rejected.
        vm.prank(gateSigner);
        vm.expectRevert(LiveRoom.RoomIsClosed.selector);
        room.suspendRoom(seq++);

        // An unprivileged keeper closes the remaining slots.
        address[] memory open = new address[](2);
        open[0] = address(headline);
        open[1] = address(micro);
        vm.prank(keeper);
        room.closeRemainingSlots(open);
        assertEq(uint256(headline.gateState()), uint256(LivePredictionMarket.GateState.Closed));
        assertEq(uint256(micro.gateState()), uint256(LivePredictionMarket.GateState.Closed));
        assertEq(room.openSlotCount(), 0);
    }

    /// The real chain found this: `processRoom` executes pending actions, whose
    /// cost scales with the work in the epoch, but it was called with the same
    /// fixed 500k stipend as the cheap gating calls. A liquidity deposit ran out
    /// of gas, the child was skipped with empty revert data, and because skips
    /// are isolated by design the failure was completely silent — the market
    /// simply never became backed.
    function testProcessRoomHasEnoughGasToExecuteRealWork() public {
        LivePredictionMarket headline = _publishHeadline();
        vm.warp(headline.opensAt());
        uint64 epoch = headline.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(headline), 2_000 * U);
        headline.submitAddLiquidity(2_000 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();

        vm.warp(headline.epochEndsAt(epoch) + 11);
        address[] memory markets = new address[](1);
        markets[0] = address(headline);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);
        assertTrue(headline.epochSafe(epoch), "the epoch is safe");

        room.processRoom(markets, epochs, type(uint256).max);
        assertTrue(headline.hasLiquidity(), "the deposit must actually execute through processRoom");
        assertEq(headline.totalLpShares(), 2_000 * U);
    }

    /// A cheap skip-on-low-gas path is self-fulfilling under gas estimation:
    /// the estimator finds a low limit "succeeds" because everything is
    /// skipped, so the batch silently does nothing forever. Refusing makes the
    /// estimator find a limit that actually executes the work.
    function testProcessRoomRefusesRatherThanSilentlySkippingOnLowGas() public {
        LivePredictionMarket headline = _publishHeadline();
        vm.warp(headline.opensAt());
        uint64 epoch = headline.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(headline), 2_000 * U);
        headline.submitAddLiquidity(2_000 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        vm.warp(headline.epochEndsAt(epoch) + 11);

        address[] memory markets = new address[](1);
        markets[0] = address(headline);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);

        (bool ok, bytes memory reason) =
            address(room).call{gas: 150_000}(abi.encodeCall(LiveRoom.processRoom, (markets, epochs, type(uint256).max)));
        assertFalse(ok, "a starved batch must refuse, not report success");
        assertFalse(headline.hasLiquidity(), "and must not half-run");
        reason; // revert data is either InsufficientGas or an out-of-gas abort

        // With a workable limit the same call does the work.
        room.processRoom(markets, epochs, type(uint256).max);
        assertTrue(headline.hasLiquidity());
    }

    /// Several markets in one batch each get a workable share of gas.
    function testProcessRoomSpreadsGasAcrossEveryMarket() public {
        LivePredictionMarket headline = _publishHeadline();
        _seedSlot(headline, 1_000 * U);
        LivePredictionMarket m1 = _publish(TPL_THRESHOLD, 0, "Micro A");
        LivePredictionMarket m2 = _publish(TPL_THRESHOLD, 0, "Micro B");
        vm.warp(m2.opensAt());

        uint64 epoch = headline.currentEpoch();
        LivePredictionMarket[2] memory micros = [m1, m2];
        for (uint256 i = 0; i < micros.length; i++) {
            vm.startPrank(lp);
            usdc.approve(address(micros[i]), 500 * U);
            micros[i].submitAddLiquidity(500 * U, 1, uint64(block.timestamp + 10 minutes));
            vm.stopPrank();
        }
        vm.startPrank(trader);
        usdc.approve(address(headline), 100 * U);
        headline.submitBuy(true, 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();

        vm.warp(headline.epochEndsAt(epoch) + 11);
        address[] memory markets = new address[](3);
        uint64[] memory epochs = new uint64[](3);
        markets[0] = address(headline);
        markets[1] = address(m1);
        markets[2] = address(m2);
        for (uint256 i = 0; i < 3; i++) {
            epochs[i] = epoch;
        }
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);
        room.processRoom(markets, epochs, type(uint256).max);

        assertGt(headline.positionAOf(trader), 0, "the buy executed");
        assertTrue(m1.hasLiquidity(), "micro A funded");
        assertTrue(m2.hasLiquidity(), "micro B funded");
    }

    function testSuspendAndReopenPropagateToOpenSlots() public {
        LivePredictionMarket headline = _publishHeadline();
        _seedSlot(headline, 1_000 * U);

        vm.prank(gateSigner);
        room.suspendRoom(seq++);
        assertEq(uint256(headline.gateState()), uint256(LivePredictionMarket.GateState.Suspended));

        vm.startPrank(trader);
        usdc.approve(address(headline), 10 * U);
        vm.expectRevert(LivePredictionMarket.InvalidState.selector);
        headline.submitBuy(true, 10 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();

        vm.prank(gateSigner);
        room.reopenRoom(seq++);
        assertEq(uint256(headline.gateState()), uint256(LivePredictionMarket.GateState.Open));
    }
}
