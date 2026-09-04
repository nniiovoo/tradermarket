// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Regression tests for the independent review's contract findings.
///
/// (1) A Publication Permit must bind a canonical hash of the COMPLETE slot
///     request — template id, winner setting, question and media metadata, and
///     the per-slot restricted-wallet list — not just two hashes. Otherwise the
///     publisher can vary everything the gate did not sign.
/// (4) createRoomMarket must require the caller to be the registered room and
///     must bind roomId/slotIndex to the deterministic salt.
/// (5) initialize must reject a zero integrity claim window or timeout.
/// (6) The permit must carry a signed issuedAt, and age must be measured from
///     issuance, not from expiry.
contract PermitBindingTest is Test {
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
    address internal insider = makeAddr("disclosed-insider");
    address internal outsider = makeAddr("outsider");

    uint256 internal nextNonce = 1;
    uint256 internal seq = 1000;

    function setUp() public {
        vm.warp(1_700_000_000);
        gateSigner = vm.addr(gatePk);
        usdc = new MockUSDC();
        factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );
        room = LiveRoom(factory.createRoom(_roomConfig(bytes32("room-permit"), 1 hours, 1 hours)));

        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        vm.startPrank(participantA);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
    }

    function _roomConfig(bytes32 roomId, uint64 claimWindow, uint64 claimTimeout)
        internal
        returns (LiveRoom.RoomConfig memory config)
    {
        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](2);
        templates[0] = LiveRoom.TemplateRule({templateId: TPL_HEADLINE, winnerRewardBps: 100});
        templates[1] = LiveRoom.TemplateRule({templateId: TPL_THRESHOLD, winnerRewardBps: 0});
        config = LiveRoom.RoomConfig({
            roomId: roomId,
            headlineTemplateId: TPL_HEADLINE,
            gateSigner: gateSigner,
            publisher: publisher,
            integrityAdjudicator: adjudicator,
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
            bondRecipient: makeAddr("bondRecipient"),
            liquidityRouter: address(0),
            resolvers: [makeAddr("r1"), makeAddr("r2"), makeAddr("r3")],
            epochDuration: 10,
            sourceFinalityDelay: 10,
            maxPendingTime: 90,
            challengeWindow: 10 minutes,
            challengeTimeout: 30 minutes,
            minAnnounceDelay: 30,
            maxPermitLifetime: 5 minutes,
            integrityClaimWindow: claimWindow,
            integrityClaimTimeout: claimTimeout,
            gateStallTimeout: 6 hours,
            maxOpenSlots: 4,
            participantAName: "Alice",
            participantBName: "Bob",
            templates: templates,
            restrictedWallets: new address[](0)
        });
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
            imageUrl: "ipfs://image"
        });
    }

    function _permit(LiveRoom.SlotRequest memory request, address[] memory restricted, uint32 slotIndex)
        internal
        returns (LiveRoom.PublicationPermit memory)
    {
        return LiveRoom.PublicationPermit({
            slotIndex: slotIndex,
            requestHash: room.slotRequestHash(request, restricted),
            conditionHash: request.conditionHash,
            undecidedThroughSequence: seq++,
            announceDelay: request.announceDelay,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 2 minutes),
            nonce: nextNonce++
        });
    }

    function _sign(LiveRoom.PublicationPermit memory permit) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(gatePk, room.permitDigest(permit));
        return abi.encodePacked(r, s, v);
    }

    function _publishHeadline() internal returns (LivePredictionMarket) {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);
        vm.prank(publisher);
        return LivePredictionMarket(room.publishSlot(request, permit, signature, restricted));
    }

    // ------------------------------------------------ (1) full request binding

    function testPermitBindsTheCompleteRequest() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](1);
        restricted[0] = insider;
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        vm.prank(publisher);
        address market = room.publishSlot(request, permit, signature, restricted);
        assertTrue(LivePredictionMarket(market).restrictedWallet(insider), "the signed restricted list applied");
    }

    /// The publisher must not be able to swap the template after signing.
    function testSwappedTemplateIdIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        LiveRoom.SlotRequest memory swapped = request;
        swapped.templateId = TPL_THRESHOLD;
        swapped.winnerRewardBps = 0;
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(swapped, permit, signature, restricted);
    }

    /// Nor raise the winner reward on a question the gate signed as a 0 bps one.
    function testSwappedWinnerRewardIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        LiveRoom.SlotRequest memory swapped = request;
        swapped.winnerRewardBps = 0;
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(swapped, permit, signature, restricted);
    }

    /// Nor rewrite the question the audience sees.
    function testRewrittenQuestionIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        LiveRoom.SlotRequest memory swapped = request;
        swapped.question = "Something the gate never saw";
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(swapped, permit, signature, restricted);
    }

    /// Nor point the room at a different stream or image.
    function testSwappedMediaMetadataIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        LiveRoom.SlotRequest memory swappedStream = request;
        swappedStream.streamUrl = "https://attacker.example/live";
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(swappedStream, permit, signature, restricted);

        LiveRoom.SlotRequest memory swappedImage = request;
        swappedImage.imageUrl = "ipfs://other";
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(swappedImage, permit, signature, restricted);
    }

    /// Nor drop a disclosed insider from the restricted list after signing.
    function testStrippedRestrictedWalletListIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](1);
        restricted[0] = insider;
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        address[] memory stripped = new address[](0);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(request, permit, signature, stripped);
    }

    /// Nor add an unsigned wallet to it.
    function testAddedRestrictedWalletIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](1);
        restricted[0] = insider;
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        address[] memory extended = new address[](2);
        extended[0] = insider;
        extended[1] = outsider;
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(request, permit, signature, extended);
    }

    /// Reordering the restricted list is also a different list.
    function testReorderedRestrictedWalletListIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](2);
        restricted[0] = insider;
        restricted[1] = outsider;
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);

        address[] memory reordered = new address[](2);
        reordered[0] = outsider;
        reordered[1] = insider;
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(request, permit, signature, reordered);
    }

    /// The condition hash stays separately bound: the market records it.
    function testConditionHashMismatchIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        permit.conditionHash = keccak256("a different condition");
        bytes memory signature = _sign(permit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitMismatch.selector);
        room.publishSlot(request, permit, signature, restricted);
    }

    // ------------------------------------------------------- (6) issuedAt

    function testPermitIssuedInTheFutureIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        permit.issuedAt = uint64(block.timestamp + 30);
        bytes memory signature = _sign(permit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitNotYetIssued.selector);
        room.publishSlot(request, permit, signature, restricted);
    }

    /// A permit whose declared lifetime exceeds the frozen maximum is refused
    /// even while it is still unexpired.
    function testPermitWithTooLongADeclaredLifetimeIsRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        permit.expiresAt = uint64(permit.issuedAt + 6 minutes); // maxPermitLifetime is 5 minutes
        bytes memory signature = _sign(permit);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitTooLongLived.selector);
        room.publishSlot(request, permit, signature, restricted);
    }

    /// THE HOLE THE REVIEW FOUND: the old check was expiry-relative
    /// (`expiresAt <= now + maxPermitLifetime`), so a permit issued long ago
    /// whose expiry merely happened to be near still passed — its undecidedness
    /// claim could be hours stale. Binding `issuedAt` closes it: the declared
    /// lifetime is bounded at signing time, so staleness is now impossible
    /// rather than merely unlikely.
    function testStalePermitIsRejectedByIssuanceBinding() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);

        // Issued a day ago, expiring in four minutes. Under the old
        // expiry-relative rule this passed. It is now refused on its declared
        // lifetime, before the signature is even considered admissible.
        LiveRoom.PublicationPermit memory stale = _permit(request, restricted, 0);
        stale.issuedAt = uint64(block.timestamp - 1 days);
        stale.expiresAt = uint64(block.timestamp + 4 minutes);
        bytes memory staleSignature = _sign(stale);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitTooLongLived.selector);
        room.publishSlot(request, stale, staleSignature, restricted);
    }

    /// Defense in depth: `PermitTooOld` is unreachable while the other two
    /// checks hold, and this states why. If a permit is unexpired
    /// (expiresAt > now) and its declared lifetime is within the maximum
    /// (expiresAt - issuedAt <= max), then age = now - issuedAt < expiresAt -
    /// issuedAt <= max. The check remains so a future refactor that loosens
    /// either bound cannot silently reintroduce staleness.
    function testFuzzNoUnexpiredPermitCanExceedTheMaxAge(uint64 issuedOffset, uint64 lifetime) public view {
        uint64 maxLifetime = room.maxPermitLifetime();
        uint64 nowS = uint64(block.timestamp);
        uint64 issuedAt = uint64(bound(issuedOffset, 0, 10 days));
        issuedAt = nowS > issuedAt ? nowS - issuedAt : 0;
        uint64 declared = uint64(bound(lifetime, 1, maxLifetime));
        uint64 expiresAt = issuedAt + declared;

        // Only consider permits that would pass the first two checks.
        if (issuedAt > nowS) return;
        if (expiresAt <= nowS) return;
        assertLe(uint256(nowS - issuedAt), uint256(maxLifetime), "an unexpired, well-formed permit is never too old");
    }

    function testFreshPermitWithinItsLifetimeIsAccepted() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);
        vm.warp(block.timestamp + 60); // one minute old, lifetime is five
        vm.prank(publisher);
        address market = room.publishSlot(request, permit, signature, restricted);
        assertGt(market.code.length, 0);
    }

    function testExpiredPermitIsStillRejected() public {
        LiveRoom.SlotRequest memory request = _request(TPL_HEADLINE, 100, "Who wins?");
        address[] memory restricted = new address[](0);
        LiveRoom.PublicationPermit memory permit = _permit(request, restricted, 0);
        bytes memory signature = _sign(permit);
        vm.warp(block.timestamp + 3 minutes);
        vm.prank(publisher);
        vm.expectRevert(LiveRoom.PermitExpired.selector);
        room.publishSlot(request, permit, signature, restricted);
    }

    // ------------------------------------------- (4) factory room binding

    function testOnlyTheRegisteredRoomMayCreateItsSlots() public {
        // The factory admin holds MARKET_CREATOR_ROLE for standalone markets,
        // but must not be able to mint a market into someone else's room.
        LivePredictionMarket.MarketConfig memory config = _marketConfig(bytes32("room-permit"), 7);
        vm.expectRevert(LiveMarketFactory.NotTheRoom.selector);
        factory.createRoomMarket(config, new address[](0), bytes32("room-permit"), 7);
    }

    function testUnknownRoomIdCannotCreateASlot() public {
        LivePredictionMarket.MarketConfig memory config = _marketConfig(bytes32("no-such-room"), 0);
        vm.expectRevert(LiveMarketFactory.NotTheRoom.selector);
        factory.createRoomMarket(config, new address[](0), bytes32("no-such-room"), 0);
    }

    function testConfigRoomBindingMustMatchTheSalt() public {
        // A room cannot mint a slot whose config claims a different room or index.
        LivePredictionMarket.MarketConfig memory wrongRoom = _marketConfig(bytes32("other-room"), 0);
        vm.prank(address(room));
        vm.expectRevert(LiveMarketFactory.SaltBindingMismatch.selector);
        factory.createRoomMarket(wrongRoom, new address[](0), bytes32("room-permit"), 0);

        LivePredictionMarket.MarketConfig memory wrongIndex = _marketConfig(bytes32("room-permit"), 9);
        vm.prank(address(room));
        vm.expectRevert(LiveMarketFactory.SaltBindingMismatch.selector);
        factory.createRoomMarket(wrongIndex, new address[](0), bytes32("room-permit"), 3);
    }

    function testTheRoomItselfStillPublishesNormally() public {
        LivePredictionMarket market = _publishHeadline();
        (bytes32 roomId, uint32 slotIndex,,,) = market.slotBinding();
        assertEq(roomId, bytes32("room-permit"));
        assertEq(slotIndex, 0);
        assertEq(address(market), factory.predictMarketAddress(bytes32("room-permit"), 0));
    }

    function _marketConfig(bytes32 roomId, uint32 slotIndex)
        internal
        returns (LivePredictionMarket.MarketConfig memory config)
    {
        config.collateral = address(usdc);
        config.admin = address(this);
        config.gateOracle = address(room);
        config.participantA = participantA;
        config.participantB = participantB;
        config.rewardAddressA = participantA;
        config.rewardAddressB = participantB;
        config.bondRecipient = makeAddr("bondRecipient2");
        config.resolvers = [makeAddr("q1"), makeAddr("q2"), makeAddr("q3")];
        config.epochDuration = 10;
        config.sourceFinalityDelay = 10;
        config.maxPendingTime = 90;
        config.challengeWindow = 10 minutes;
        config.challengeTimeout = 30 minutes;
        config.roomId = roomId;
        config.slotIndex = slotIndex;
        config.templateId = TPL_HEADLINE;
        config.conditionHash = keccak256("c");
        config.winnerRewardBps = 100;
        config.opensAt = 0;
        config.readinessSource = address(room);
        config.liquidityRouter = address(0);
        config.participantAName = "Alice";
        config.participantBName = "Bob";
        config.question = "Injected";
        config.streamUrl = "";
        config.imageUrl = "";
    }

    // --------------------------------------- (5) claim window validation

    function testZeroIntegrityClaimWindowIsRejected() public {
        vm.expectRevert(LiveRoom.InvalidConfig.selector);
        factory.createRoom(_roomConfig(bytes32("zero-window"), 0, 1 hours));
    }

    function testZeroIntegrityClaimTimeoutIsRejected() public {
        vm.expectRevert(LiveRoom.InvalidConfig.selector);
        factory.createRoom(_roomConfig(bytes32("zero-timeout"), 1 hours, 0));
    }
}
