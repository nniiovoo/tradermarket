// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Issue 13: the Integrity Bond moves to the Live Room. One bond per Participant
/// per Live Session; release requires all four frozen conditions; the market
/// delegates readiness and refuses per-market bond operations.
contract RoomIntegrityBondTest is Test {
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
    address internal bondRecipient = makeAddr("bondRecipient");
    address internal resolver1 = makeAddr("resolver1");
    address internal resolver2 = makeAddr("resolver2");
    address internal resolver3 = makeAddr("resolver3");
    address internal lp = makeAddr("lp");
    address internal claimant = makeAddr("claimant");
    address internal keeper = makeAddr("keeper");

    uint256 internal nextNonce = 1;
    uint256 internal seq = 1000;

    function setUp() public {
        gateSigner = vm.addr(gatePk);
        usdc = new MockUSDC();
        factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );

        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](2);
        templates[0] = LiveRoom.TemplateRule({templateId: TPL_HEADLINE, winnerRewardBps: 100});
        templates[1] = LiveRoom.TemplateRule({templateId: TPL_THRESHOLD, winnerRewardBps: 0});

        LiveRoom.RoomConfig memory config = LiveRoom.RoomConfig({
            roomId: bytes32("room-bond"),
            headlineTemplateId: TPL_HEADLINE,
            gateSigner: gateSigner,
            publisher: publisher,
            integrityAdjudicator: adjudicator,
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
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
            maxOpenSlots: 5,
            participantAName: "Nova",
            participantBName: "Arc",
            templates: templates,
            restrictedWallets: new address[](0)
        });
        room = LiveRoom(factory.createRoom(config));

        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        usdc.mint(lp, 100_000 * U);
        usdc.mint(claimant, 1_000 * U);
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

    function _seed(LivePredictionMarket market) internal {
        vm.warp(market.opensAt());
        uint64 epoch = market.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(market), 100 * U);
        market.submitAddLiquidity(100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        vm.warp(market.epochEndsAt(epoch) + 6);
        address[] memory markets = new address[](1);
        markets[0] = address(market);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, markets, epochs);
        room.processRoom(markets, epochs, type(uint256).max);
    }

    function _finalizeSlot(LivePredictionMarket market, LivePredictionMarket.Outcome outcome) internal {
        bytes32 evidence = keccak256(abi.encode("evidence", address(market)));
        vm.prank(resolver1);
        market.attestResult(outcome, evidence);
        vm.prank(resolver2);
        market.attestResult(outcome, evidence);
        vm.warp(block.timestamp + market.challengeWindow());
        market.finalizeUnchallenged();
    }

    function testFiveSlotRoomNeedsExactlyTwoBondTransactions() public {
        _postBonds();
        assertTrue(room.participantsReady());

        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline);
        for (uint256 i = 0; i < 4; i++) {
            _publish(TPL_THRESHOLD, 0, string(abi.encodePacked("Micro ", vm.toString(i))));
        }
        assertEq(room.slotCount(), 5, "five slots from two bond transactions");
        for (uint256 i = 0; i < 5; i++) {
            assertTrue(LivePredictionMarket(room.slotAt(i)).isReady(), "every slot ready via the room");
        }
    }

    function testMarketRefusesPerMarketBondOperationsInRoomMode() public {
        _postBonds();
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");

        vm.startPrank(participantA);
        usdc.approve(address(headline), 100 * U);
        vm.expectRevert(LivePredictionMarket.RoomManagesBonds.selector);
        headline.postIntegrityBond();
        vm.stopPrank();

        assertEq(headline.totalIntegrityBondLiability(), 0, "room-bound market reports no bond liability");
        assertEq(headline.accountedLiabilities(), 0);
    }

    function testPublishBlockedUntilBothBondsPosted() public {
        vm.startPrank(participantA);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
        assertFalse(room.participantsReady(), "one bond is not readiness");

        LiveRoom.SlotRequest memory request = LiveRoom.SlotRequest({
            templateId: TPL_HEADLINE,
            templateParamsHash: keccak256("params"),
            conditionHash: keccak256("condition"),
            announceDelay: 30,
            winnerRewardBps: 100,
            question: "Q",
            streamUrl: "",
            imageUrl: ""
        });
        LiveRoom.PublicationPermit memory permit = LiveRoom.PublicationPermit({
            slotIndex: 0,
            requestHash: room.slotRequestHash(request, new address[](0)),
            conditionHash: request.conditionHash,
            undecidedThroughSequence: seq++,
            announceDelay: 30,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 2 minutes),
            nonce: nextNonce++
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(gatePk, room.permitDigest(permit));
        bytes memory signature = abi.encodePacked(r, s, v);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.NotReady.selector);
        room.publishSlot(request, permit, signature, new address[](0));
    }

    function testDuplicateBondAndNonParticipantRejected() public {
        _postBonds();
        vm.startPrank(participantA);
        usdc.approve(address(room), 100 * U);
        vm.expectRevert(LiveRoom.InvalidState.selector);
        room.postIntegrityBond();
        vm.stopPrank();

        vm.startPrank(keeper);
        usdc.approve(address(room), 100 * U);
        vm.expectRevert(LiveRoom.NotAuthorized.selector);
        room.postIntegrityBond();
        vm.stopPrank();
    }

    function testBondReleaseRequiresAllFourConditions() public {
        _postBonds();
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline);
        LivePredictionMarket micro = _publish(TPL_THRESHOLD, 0, "Micro");

        // Condition 1: the room is not closed.
        vm.prank(participantA);
        vm.expectRevert(LiveRoom.RoomNotClosed.selector);
        room.claimIntegrityBond();

        // Close the micro slot, then the room.
        address[] memory microOnly = new address[](1);
        microOnly[0] = address(micro);
        vm.prank(gateSigner);
        room.closeSlots(seq++, microOnly);
        uint256 terminal = seq++;
        vm.prank(gateSigner);
        room.closeRoom(terminal);
        address[] memory rest = new address[](1);
        rest[0] = address(headline);
        vm.prank(keeper);
        room.closeRemainingSlots(rest);

        // Condition 3: slots exist that are not Final or Invalid.
        vm.prank(participantA);
        vm.expectRevert(LiveRoom.TooEarly.selector);
        room.claimIntegrityBond();

        _finalizeSlot(headline, LivePredictionMarket.Outcome.ParticipantA);
        _finalizeSlot(micro, LivePredictionMarket.Outcome.Invalid);

        // Condition 4a: the claim window has not elapsed.
        vm.prank(participantA);
        vm.expectRevert(LiveRoom.TooEarly.selector);
        room.claimIntegrityBond();

        // Condition 4b: an unresolved claim blocks only the accused participant.
        vm.startPrank(claimant);
        usdc.approve(address(room), 10 * U);
        uint256 claimId = room.fileIntegrityClaim(participantA, bytes32("V-001"), keccak256("evidence"));
        vm.stopPrank();

        vm.warp(uint256(room.roomClosedAt()) + room.integrityClaimWindow());
        vm.prank(participantA);
        vm.expectRevert(LiveRoom.TooEarly.selector);
        room.claimIntegrityBond();

        // The unaccused participant is free to claim.
        uint256 balanceBefore = usdc.balanceOf(participantB);
        vm.prank(participantB);
        room.claimIntegrityBond();
        assertEq(usdc.balanceOf(participantB), balanceBefore + 100 * U);

        // Rejected claim: claimant bond forfeits to the bond recipient; the accused can claim.
        vm.prank(adjudicator);
        room.adjudicateIntegrityClaim(claimId, false);
        assertEq(usdc.balanceOf(bondRecipient), 10 * U);

        uint256 aBefore = usdc.balanceOf(participantA);
        vm.prank(participantA);
        room.claimIntegrityBond();
        assertEq(usdc.balanceOf(participantA), aBefore + 100 * U);
        assertEq(usdc.balanceOf(address(room)), 0, "room retains nothing after settlement");
    }

    function testUpheldClaimForfeitsBondToRecipient() public {
        _postBonds();
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline);
        uint256 terminal = seq++;
        vm.prank(gateSigner);
        room.closeRoom(terminal);
        address[] memory rest = new address[](1);
        rest[0] = address(headline);
        room.closeRemainingSlots(rest);
        _finalizeSlot(headline, LivePredictionMarket.Outcome.ParticipantA);

        vm.startPrank(claimant);
        usdc.approve(address(room), 10 * U);
        uint256 claimId = room.fileIntegrityClaim(participantA, bytes32("V-002"), keccak256("proof"));
        vm.stopPrank();

        uint256 claimantBefore = usdc.balanceOf(claimant);
        vm.prank(adjudicator);
        room.adjudicateIntegrityClaim(claimId, true);
        assertEq(usdc.balanceOf(bondRecipient), 100 * U, "forfeited participant bond");
        assertEq(usdc.balanceOf(claimant), claimantBefore + 10 * U, "claimant bond returned");

        vm.warp(uint256(room.roomClosedAt()) + room.integrityClaimWindow());
        vm.prank(participantA);
        vm.expectRevert(LiveRoom.NothingToClaim.selector);
        room.claimIntegrityBond();

        // The other participant is unaffected.
        vm.prank(participantB);
        room.claimIntegrityBond();
    }

    function testExpiredClaimReturnsClaimantBondAndUnblocks() public {
        _postBonds();
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline);
        vm.prank(gateSigner);
        room.closeRoom(seq++);
        address[] memory rest = new address[](1);
        rest[0] = address(headline);
        room.closeRemainingSlots(rest);
        _finalizeSlot(headline, LivePredictionMarket.Outcome.Tie);

        vm.startPrank(claimant);
        usdc.approve(address(room), 10 * U);
        uint256 claimId = room.fileIntegrityClaim(participantB, bytes32("V-003"), keccak256("thin"));
        vm.stopPrank();

        // The adjudicator never rules. After the timeout anyone expires the claim:
        // unproven means the participant bond stays returnable.
        vm.warp(block.timestamp + room.integrityClaimTimeout());
        vm.prank(adjudicator);
        vm.expectRevert(LiveRoom.TooEarly.selector);
        room.adjudicateIntegrityClaim(claimId, true);

        uint256 claimantBefore = usdc.balanceOf(claimant);
        vm.prank(keeper);
        room.expireIntegrityClaim(claimId);
        assertEq(usdc.balanceOf(claimant), claimantBefore + 10 * U);

        vm.warp(uint256(room.roomClosedAt()) + room.integrityClaimWindow());
        vm.prank(participantB);
        room.claimIntegrityBond();
    }

    function testClaimWindowClosesFiling() public {
        _postBonds();
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline);
        vm.prank(gateSigner);
        room.closeRoom(seq++);
        vm.warp(uint256(room.roomClosedAt()) + room.integrityClaimWindow());

        vm.startPrank(claimant);
        usdc.approve(address(room), 10 * U);
        vm.expectRevert(LiveRoom.TooEarly.selector);
        room.fileIntegrityClaim(participantA, bytes32("V-004"), keccak256("late"));
        vm.stopPrank();
    }

    function testOnlyAdjudicatorRules() public {
        _postBonds();
        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        _seed(headline);
        vm.prank(gateSigner);
        room.closeRoom(seq++);
        vm.startPrank(claimant);
        usdc.approve(address(room), 10 * U);
        uint256 claimId = room.fileIntegrityClaim(participantA, bytes32("V-005"), keccak256("evidence"));
        vm.stopPrank();

        vm.prank(keeper);
        vm.expectRevert(LiveRoom.NotAuthorized.selector);
        room.adjudicateIntegrityClaim(claimId, true);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.NotAuthorized.selector);
        room.adjudicateIntegrityClaim(claimId, true);
    }
}
