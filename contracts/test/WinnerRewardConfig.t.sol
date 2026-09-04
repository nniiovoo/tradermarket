// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {MarketMath} from "../src/MarketMath.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Issue 01: room binding fields and a configurable, frozen Winner Reward.
contract WinnerRewardConfigTest is Test {
    uint256 private constant U = 1e6;

    MockUSDC internal usdc;
    LivePredictionMarket internal implementation;
    LiveMarketFactory internal factory;

    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");
    address internal gateOracle = makeAddr("gateOracle");
    address internal resolver1 = makeAddr("resolver1");
    address internal resolver2 = makeAddr("resolver2");
    address internal resolver3 = makeAddr("resolver3");
    address internal bondRecipient = makeAddr("bondRecipient");
    address internal lp1 = makeAddr("lp1");
    address internal trader = makeAddr("trader");

    uint256 internal nextSequence = 1;

    function setUp() public {
        usdc = new MockUSDC();
        implementation = new LivePredictionMarket();
        factory = new LiveMarketFactory(address(usdc), address(this), address(implementation), address(new LiveRoom()));
    }

    function _config(uint16 winnerRewardBps) internal view returns (LivePredictionMarket.MarketConfig memory) {
        return LivePredictionMarket.MarketConfig({
            collateral: address(0),
            admin: address(this),
            gateOracle: gateOracle,
            participantA: participantA,
            participantB: participantB,
            rewardAddressA: participantA,
            rewardAddressB: participantB,
            bondRecipient: bondRecipient,
            resolvers: [resolver1, resolver2, resolver3],
            epochDuration: 30,
            sourceFinalityDelay: 5,
            maxPendingTime: 120,
            challengeWindow: 10 minutes,
            challengeTimeout: 30 minutes,
            roomId: bytes32("room-1"),
            slotIndex: 2,
            templateId: bytes32("tpl-threshold-v1"),
            conditionHash: keccak256("condition-doc"),
            winnerRewardBps: winnerRewardBps,
            opensAt: 0,
            readinessSource: address(0),
            liquidityRouter: address(0),
            participantAName: "Nova",
            participantBName: "Arc",
            question: "Will Nova's return exceed 2%?",
            streamUrl: "https://example.com/live.m3u8",
            imageUrl: "ipfs://market-image"
        });
    }

    function _deploy(uint16 bps) internal returns (LivePredictionMarket market) {
        address[] memory restricted = new address[](0);
        market = LivePredictionMarket(factory.createMarket(_config(bps), restricted));
        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        usdc.mint(lp1, 20_000 * U);
        usdc.mint(trader, 20_000 * U);
        vm.startPrank(participantA);
        usdc.approve(address(market), 100 * U);
        market.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(market), 100 * U);
        market.postIntegrityBond();
        vm.stopPrank();
    }

    function _clear(LivePredictionMarket market, uint64 epoch) internal {
        uint256 readyAt = market.epochEndsAt(epoch) + market.sourceFinalityDelay();
        if (block.timestamp < readyAt) vm.warp(readyAt);
        vm.prank(gateOracle);
        market.markEpochSafe(epoch, nextSequence++);
        market.processEpoch(epoch, type(uint256).max);
    }

    function _seed(LivePredictionMarket market) internal {
        uint64 epoch = market.currentEpoch();
        vm.startPrank(lp1);
        usdc.approve(address(market), 1_000 * U);
        market.submitAddLiquidity(1_000 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(market, epoch);
    }

    function _buy(LivePredictionMarket market, uint256 budget) internal {
        uint64 epoch = market.currentEpoch();
        vm.startPrank(trader);
        usdc.approve(address(market), budget);
        market.submitBuy(true, budget, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(market, epoch);
    }

    function _finalize(LivePredictionMarket market, LivePredictionMarket.Outcome outcome) internal {
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        bytes32 evidence = keccak256("evidence");
        vm.prank(resolver1);
        market.attestResult(outcome, evidence);
        vm.prank(resolver2);
        market.attestResult(outcome, evidence);
        vm.warp(block.timestamp + market.challengeWindow());
        market.finalizeUnchallenged();
    }

    function testRoomBindingStoredAndFrozen() public {
        LivePredictionMarket market = _deploy(100);
        (bytes32 roomId, uint32 slotIndex, bytes32 templateId, bytes32 conditionHash, uint16 bps) = market.slotBinding();
        assertEq(roomId, bytes32("room-1"));
        assertEq(slotIndex, 2);
        assertEq(templateId, bytes32("tpl-threshold-v1"));
        assertEq(conditionHash, keccak256("condition-doc"));
        assertEq(bps, 100);
        assertEq(market.winnerRewardBps(), 100);
    }

    function testRejectsWinnerRewardAbove100Bps() public {
        LivePredictionMarket.MarketConfig memory config = _config(101);
        address[] memory restricted = new address[](0);
        vm.expectRevert(LivePredictionMarket.InvalidState.selector);
        factory.createMarket(config, restricted);
    }

    function testHundredBpsSplitMatchesFrozenRule() public {
        LivePredictionMarket market = _deploy(100);
        _seed(market);
        MarketMath.BuyQuote memory quote = market.quoteBuy(true, 100 * U);
        assertEq(quote.tradeInput, 98_700_000);
        assertEq(quote.winnerRewardFee, 1_000_000);
        assertEq(quote.liquidityFee, 300_000);
    }

    function testZeroBpsMarketEndToEnd() public {
        LivePredictionMarket market = _deploy(0);
        _seed(market);

        MarketMath.BuyQuote memory quote = market.quoteBuy(true, 100 * U);
        assertEq(quote.winnerRewardFee, 0, "threshold market charges no winner fee");
        assertEq(quote.liquidityFee, 300_000, "LP fee unchanged at 0 bps");
        assertEq(quote.tradeInput, 99_700_000);

        _buy(market, 100 * U);
        assertEq(market.winnerRewardPool(), 0);
        assertEq(market.winnerFeePaid(trader), 0);
        assertEq(market.unclaimedLpFees(), 300_000);
        assertGt(market.positionAOf(trader), 0);

        _finalize(market, LivePredictionMarket.Outcome.ParticipantA);

        vm.prank(participantA);
        vm.expectRevert(LivePredictionMarket.NothingToClaim.selector);
        market.claimWinnerReward();

        uint256 positions = market.positionAOf(trader);
        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        market.redeemPositions();
        assertEq(usdc.balanceOf(trader), before + positions);

        vm.prank(lp1);
        market.settleLpInventory();
        vm.prank(lp1);
        market.claimLpFees();
        vm.prank(participantA);
        market.claimIntegrityBond();
        vm.prank(participantB);
        market.claimIntegrityBond();
        assertLe(market.accountedLiabilities(), usdc.balanceOf(address(market)));
    }

    function testZeroBpsInvalidMarketHasNoWinnerFeeRefund() public {
        LivePredictionMarket market = _deploy(0);
        _seed(market);
        _buy(market, 100 * U);

        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        vm.warp(market.resolutionDueAt() + 1);
        market.invalidateUnresolved();

        vm.prank(trader);
        vm.expectRevert(LivePredictionMarket.NothingToClaim.selector);
        market.claimInvalidWinnerFeeRefund();

        uint256 positionsA = market.positionAOf(trader);
        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        market.redeemPositions();
        assertEq(usdc.balanceOf(trader), before + positionsA / 2);
        assertLe(market.accountedLiabilities(), usdc.balanceOf(address(market)));
    }

    function testFuzzBudgetSplitSumsAtBothSettings(uint96 rawBudget, bool zeroBps) public {
        LivePredictionMarket market = _deploy(zeroBps ? 0 : 100);
        _seed(market);
        uint256 budget = bound(uint256(rawBudget), 1 * U, 1_000_000 * U);
        MarketMath.BuyQuote memory quote = market.quoteBuy(true, budget);
        assertEq(quote.tradeInput + quote.winnerRewardFee + quote.liquidityFee, budget);
        if (zeroBps) assertEq(quote.winnerRewardFee, 0);
        else assertEq(quote.winnerRewardFee, (budget * 100) / 10_000);
        assertGe(
            quote.newSelectedReserve * quote.newOtherReserve,
            market.reserveA() * market.reserveB(),
            "constant product preserved"
        );
    }
}
