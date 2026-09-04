// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Random buys, sells, liquidity adds, transfers, clears, refunds, and closes.
/// The market's accounted liabilities must never exceed its USDC balance, and
/// gate/authorization boundaries must hold under arbitrary call order.
contract MarketHandler is Test {
    uint256 private constant U = 1e6;

    MockUSDC public usdc;
    LivePredictionMarket public market;
    address public gateOracle;
    uint256 public nextSequence = 1;
    address[] public actors;

    constructor(MockUSDC usdc_, LivePredictionMarket market_, address gateOracle_) {
        usdc = usdc_;
        market = market_;
        gateOracle = gateOracle_;
        for (uint256 i = 0; i < 4; i++) {
            address actor = address(uint160(0xF00D + i));
            actors.push(actor);
            usdc.mint(actor, 1_000_000 * U);
        }
    }

    function setNextSequence(uint256 value) external {
        nextSequence = value;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function buy(uint256 seed, uint96 rawBudget, bool outcomeA) external {
        if (market.gateState() != LivePredictionMarket.GateState.Open || !market.hasLiquidity()) return;
        address actor = _actor(seed);
        uint256 budget = bound(uint256(rawBudget), 1 * U, 10_000 * U);
        vm.startPrank(actor);
        usdc.approve(address(market), budget);
        market.submitBuy(outcomeA, budget, 0, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
    }

    function sell(uint256 seed, uint96 rawAmount, bool outcomeA) external {
        if (market.gateState() != LivePredictionMarket.GateState.Open) return;
        address actor = _actor(seed);
        uint256 held = outcomeA ? market.positionAOf(actor) : market.positionBOf(actor);
        if (held == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, held);
        vm.prank(actor);
        market.submitSell(outcomeA, amount, 0, uint64(block.timestamp + 1 hours));
    }

    function addLiquidity(uint256 seed, uint96 rawAmount) external {
        if (market.gateState() != LivePredictionMarket.GateState.Open) return;
        address actor = _actor(seed);
        uint256 amount = bound(uint256(rawAmount), 1 * U, 50_000 * U);
        vm.startPrank(actor);
        usdc.approve(address(market), amount);
        market.submitAddLiquidity(amount, 0, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
    }

    function transferPosition(uint256 seed, uint96 rawAmount, bool outcomeA) external {
        if (market.gateState() != LivePredictionMarket.GateState.Open) return;
        address actor = _actor(seed);
        address recipient = _actor(seed / 7 + 1);
        if (recipient == actor) return;
        uint256 held = outcomeA ? market.positionAOf(actor) : market.positionBOf(actor);
        if (held == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, held);
        vm.prank(actor);
        market.submitPositionTransfer(outcomeA, recipient, amount, uint64(block.timestamp + 1 hours));
    }

    function warpAndClear(uint16 rawJump) external {
        uint64 epoch = market.currentEpoch();
        uint256 jump = bound(uint256(rawJump), 1, 120);
        vm.warp(block.timestamp + market.epochDuration() + market.sourceFinalityDelay() + jump);
        if (market.gateState() == LivePredictionMarket.GateState.Closed) {
            market.processEpoch(epoch, 50);
            return;
        }
        vm.prank(gateOracle);
        try market.markEpochSafe(epoch, nextSequence) {
            nextSequence++;
        } catch {}
        market.processEpoch(epoch, 50);
    }

    function refundExpired(uint16 rawJump) external {
        uint64 epoch = market.currentEpoch();
        vm.warp(block.timestamp + market.maxPendingTime() + bound(uint256(rawJump), 1, 300));
        market.processEpoch(epoch, 50);
    }

    function claimFees(uint256 seed) external {
        vm.prank(_actor(seed));
        try market.claimLpFees() {} catch {}
    }
}

contract MarketSolvencyInvariantTest is Test {
    uint256 private constant U = 1e6;

    MockUSDC internal usdc;
    LivePredictionMarket internal market;
    MarketHandler internal handler;
    address internal gateOracle = makeAddr("gateOracle");
    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");

    function setUp() public {
        usdc = new MockUSDC();
        LiveMarketFactory factory = new LiveMarketFactory(
            address(usdc), address(this), address(new LivePredictionMarket()), address(new LiveRoom())
        );
        LivePredictionMarket.MarketConfig memory config = LivePredictionMarket.MarketConfig({
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
            roomId: bytes32(0),
            slotIndex: 0,
            templateId: bytes32(0),
            conditionHash: bytes32(0),
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
        market = LivePredictionMarket(factory.createMarket(config, new address[](0)));

        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        vm.startPrank(participantA);
        usdc.approve(address(market), 100 * U);
        market.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(market), 100 * U);
        market.postIntegrityBond();
        vm.stopPrank();

        handler = new MarketHandler(usdc, market, gateOracle);

        // Seed initial liquidity through the normal pending path.
        address seeder = handler.actors(0);
        vm.startPrank(seeder);
        usdc.approve(address(market), 10_000 * U);
        market.submitAddLiquidity(10_000 * U, 0, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
        vm.warp(market.epochEndsAt(market.currentEpoch()) + market.sourceFinalityDelay() + 1);
        vm.prank(gateOracle);
        market.markEpochSafe(0, 0 + 1);
        market.processEpoch(0, 10);
        handler.setNextSequence(2);

        targetContract(address(handler));
    }

    /// Solvency: every accounted liability is fully backed by held USDC.
    function invariant_LiabilitiesNeverExceedBalance() public view {
        assertLe(market.accountedLiabilities(), usdc.balanceOf(address(market)));
    }

    /// The AMM reserves are always redeemable: backing covers the worst-case
    /// payout vector (max of the two reserves is what a sole winner redeems).
    function invariant_BackingCoversWorstCaseReserves() public view {
        if (!market.hasLiquidity()) return;
        uint256 worst = market.reserveA() > market.reserveB() ? market.reserveA() : market.reserveB();
        assertLe(worst, market.collateralBacking() + 1, "worst-case redemption exceeds backing");
    }

    /// Restricted wallets can never hold positions or shares.
    function invariant_ParticipantsHoldNothing() public view {
        assertEq(market.positionAOf(participantA) + market.positionBOf(participantA), 0);
        assertEq(market.positionAOf(participantB) + market.positionBOf(participantB), 0);
        assertEq(market.lpSharesOf(participantA) + market.lpSharesOf(participantB), 0);
        assertEq(market.lpSharesOf(gateOracle), 0);
    }
}
