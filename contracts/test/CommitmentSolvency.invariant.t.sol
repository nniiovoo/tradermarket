// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {RoomLiquidityCommitments} from "../src/RoomLiquidityCommitments.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Issue 16 is money-critical: it holds LP allowances and can initiate USDC
/// movement. Its structural safety property — no balance retained between
/// transactions — and its exposure accounting are asserted under arbitrary
/// call order.
contract CommitmentHandler is Test {
    uint256 private constant U = 1e6;

    MockUSDC public usdc;
    RoomLiquidityCommitments public commitments;
    LiveRoom public room;
    address[] public markets;
    RoomLiquidityCommitments.Commitment internal _commitment;
    bytes public signature;
    uint256 public executions;

    constructor(
        MockUSDC usdc_,
        RoomLiquidityCommitments commitments_,
        LiveRoom room_,
        address[] memory markets_,
        RoomLiquidityCommitments.Commitment memory commitment_,
        bytes memory signature_
    ) {
        usdc = usdc_;
        commitments = commitments_;
        room = room_;
        markets = markets_;
        _commitment = commitment_;
        signature = signature_;
    }

    function commitment() external view returns (RoomLiquidityCommitments.Commitment memory) {
        return _commitment;
    }

    function _market(uint256 seed) internal view returns (address) {
        return markets[seed % markets.length];
    }

    function execute(uint256 seed) external {
        try commitments.execute(_commitment, signature, _market(seed)) {
            executions++;
        } catch {}
    }

    function release(uint256 seed) external {
        try commitments.releaseExposure(_commitment, _market(seed)) {} catch {}
    }

    function cancel() external {
        vm.prank(_commitment.provider);
        commitments.cancel(_commitment.nonce);
    }
}

contract CommitmentSolvencyInvariantTest is Test {
    uint256 private constant U = 1e6;
    bytes32 private constant TPL_HEADLINE = bytes32("tpl-participant-v1");
    bytes32 private constant TPL_THRESHOLD = bytes32("tpl-threshold-v1");

    MockUSDC internal usdc;
    LiveRoom internal room;
    RoomLiquidityCommitments internal commitments;
    CommitmentHandler internal handler;

    uint256 internal gatePk = 0xA11CE;
    uint256 internal lpPk = 0xB0B;
    address internal gateSigner;
    address internal lp;
    address internal publisher = makeAddr("publisher");
    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");

    uint256 internal nextNonce = 1;
    uint256 internal seq = 1000;
    uint256 internal constant MAX_SIMULTANEOUS = 300 * 1e6;
    uint256 internal constant MAX_TOTAL = 600 * 1e6;
    uint256 internal constant PER_SLOT = 100 * 1e6;

    function setUp() public {
        gateSigner = vm.addr(gatePk);
        lp = vm.addr(lpPk);
        usdc = new MockUSDC();
        LiveMarketFactory factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );
        commitments = new RoomLiquidityCommitments(address(usdc));

        LiveRoom.TemplateRule[] memory templates = new LiveRoom.TemplateRule[](2);
        templates[0] = LiveRoom.TemplateRule({templateId: TPL_HEADLINE, winnerRewardBps: 100});
        templates[1] = LiveRoom.TemplateRule({templateId: TPL_THRESHOLD, winnerRewardBps: 0});
        LiveRoom.RoomConfig memory config = LiveRoom.RoomConfig({
            roomId: bytes32("room-inv"),
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
            maxOpenSlots: 8,
            participantAName: "Nova",
            participantBName: "Arc",
            templates: templates,
            restrictedWallets: new address[](0)
        });
        room = LiveRoom(factory.createRoom(config));

        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        usdc.mint(lp, 1_000_000 * U);
        vm.startPrank(participantA);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(room), 100 * U);
        room.postIntegrityBond();
        vm.stopPrank();
        vm.prank(lp);
        usdc.approve(address(commitments), type(uint256).max);

        LivePredictionMarket headline = _publish(TPL_HEADLINE, 100, "Who wins?");
        vm.warp(headline.opensAt());
        uint64 epoch = headline.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(headline), 1_000 * U);
        headline.submitAddLiquidity(1_000 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        vm.warp(headline.epochEndsAt(epoch) + 6);
        address[] memory one = new address[](1);
        one[0] = address(headline);
        uint64[] memory epochs = new uint64[](1);
        epochs[0] = epoch;
        vm.prank(gateSigner);
        room.markRoomEpochsSafe(seq++, one, epochs);
        room.processRoom(one, epochs, type(uint256).max);

        address[] memory markets = new address[](4);
        for (uint256 i = 0; i < 4; i++) {
            markets[i] = address(_publish(TPL_THRESHOLD, 0, string(abi.encodePacked("Micro ", vm.toString(i)))));
        }
        vm.warp(LivePredictionMarket(markets[3]).opensAt());

        bytes32[] memory allowed = new bytes32[](1);
        allowed[0] = TPL_THRESHOLD;
        RoomLiquidityCommitments.Commitment memory commitment = RoomLiquidityCommitments.Commitment({
            room: address(room),
            provider: lp,
            allowedTemplates: allowed,
            amountPerSlot: PER_SLOT,
            maxSimultaneous: MAX_SIMULTANEOUS,
            maxTotal: MAX_TOTAL,
            expiresAt: uint64(block.timestamp + 30 days),
            nonce: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lpPk, commitments.commitmentId(commitment));
        handler = new CommitmentHandler(usdc, commitments, room, markets, commitment, abi.encodePacked(r, s, v));

        targetContract(address(handler));
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

    /// The commitment contract never retains collateral between transactions.
    function invariant_RouterHoldsNoBalance() public view {
        assertEq(usdc.balanceOf(address(commitments)), 0);
    }

    /// Exposure and lifetime draw never exceed the LP's signed policy.
    function invariant_ExposureWithinSignedPolicy() public view {
        bytes32 id = commitments.commitmentId(handler.commitment());
        assertLe(commitments.activeExposure(id), MAX_SIMULTANEOUS);
        assertLe(commitments.totalExecuted(id), MAX_TOTAL);
    }

    /// The router can never accumulate LP shares or positions of its own.
    function invariant_RouterHoldsNoPositions() public view {
        for (uint256 i = 0; i < 4; i++) {
            LivePredictionMarket market = LivePredictionMarket(handler.markets(i));
            assertEq(market.lpSharesOf(address(commitments)), 0);
            assertEq(market.positionAOf(address(commitments)) + market.positionBOf(address(commitments)), 0);
        }
    }
}
