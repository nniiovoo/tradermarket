// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {MarketMath} from "../src/MarketMath.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract LivePredictionMarketTest is Test {
    uint256 private constant U = 1e6;

    MockUSDC internal usdc;
    LivePredictionMarket internal implementation;
    LiveMarketFactory internal factory;
    LivePredictionMarket internal market;

    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");
    address internal gateOracle = makeAddr("gateOracle");
    address internal resolver1 = makeAddr("resolver1");
    address internal resolver2 = makeAddr("resolver2");
    address internal resolver3 = makeAddr("resolver3");
    address internal bondRecipient = makeAddr("bondRecipient");
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal trader = makeAddr("trader");
    address internal trader2 = makeAddr("trader2");
    address internal challenger = makeAddr("challenger");

    uint256 internal nextSequence = 1;

    function setUp() public {
        usdc = new MockUSDC();
        implementation = new LivePredictionMarket();
        factory = new LiveMarketFactory(address(usdc), address(this), address(implementation), address(new LiveRoom()));

        LivePredictionMarket.MarketConfig memory config = LivePredictionMarket.MarketConfig({
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
            question: "Will Nova win?",
            streamUrl: "https://example.com/live.m3u8",
            imageUrl: "ipfs://market-image"
        });
        address[] memory restricted = new address[](0);
        market = LivePredictionMarket(factory.createMarket(config, restricted));

        _mintMany(participantA, participantB, lp1, lp2, trader, trader2, challenger);
        _postBond(participantA);
        _postBond(participantB);
    }

    function _mintMany(address a, address b, address c, address d, address e, address f, address g) internal {
        usdc.mint(a, 20_000 * U);
        usdc.mint(b, 20_000 * U);
        usdc.mint(c, 20_000 * U);
        usdc.mint(d, 20_000 * U);
        usdc.mint(e, 20_000 * U);
        usdc.mint(f, 20_000 * U);
        usdc.mint(g, 20_000 * U);
    }

    function _postBond(address participant) internal {
        vm.startPrank(participant);
        usdc.approve(address(market), 100 * U);
        market.postIntegrityBond();
        vm.stopPrank();
    }

    function _submitLiquidity(address provider, uint256 amount, uint256 minimumShares)
        internal
        returns (uint64 epoch, uint256 actionId)
    {
        epoch = market.currentEpoch();
        vm.startPrank(provider);
        usdc.approve(address(market), amount);
        actionId = market.submitAddLiquidity(amount, minimumShares, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function _clear(uint64 epoch) internal {
        uint256 readyAt = market.epochEndsAt(epoch) + market.sourceFinalityDelay();
        if (block.timestamp < readyAt) vm.warp(readyAt);
        vm.prank(gateOracle);
        market.markEpochSafe(epoch, nextSequence++);
        market.processEpoch(epoch, type(uint256).max);
    }

    function _seed() internal {
        (uint64 epoch,) = _submitLiquidity(lp1, 1_000 * U, 1_000 * U);
        _clear(epoch);
    }

    function _submitBuy(address buyer, bool outcomeA, uint256 budget, uint256 minimum)
        internal
        returns (uint64 epoch, uint256 actionId)
    {
        epoch = market.currentEpoch();
        vm.startPrank(buyer);
        usdc.approve(address(market), budget);
        actionId = market.submitBuy(outcomeA, budget, minimum, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function _closeAndFinalize(LivePredictionMarket.Outcome outcome) internal {
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        bytes32 evidence = keccak256("evidence-v1");
        vm.prank(resolver1);
        market.attestResult(outcome, evidence);
        vm.prank(resolver2);
        market.attestResult(outcome, evidence);
        vm.warp(block.timestamp + market.challengeWindow());
        market.finalizeUnchallenged();
    }

    /// The resolution deadline, pinned because nothing pinned it.
    ///
    /// ADR 0011 says "the Amoy resolver-quorum deadline is 60 minutes after the
    /// Live Session ends". The contract gives 30 minutes from the decisive-event
    /// close. Both halves of that differ, and only one of them is stale:
    ///
    ///   - The ANCHOR legitimately moved. ADR 0011 predates ADR 0019
    ///     (fixed-duration livestream competitions) and ADR 0020 (event-driven
    ///     gating), which between them removed "the Live Session ends" as a
    ///     moment that exists. `closeForDecisiveEvent` is the close now.
    ///   - The DURATION is a live question, tracked as an open issue and not
    ///     settled here. ADR 0011 budgeted a 30-minute Performance Recovery
    ///     Window AND a 60-minute quorum deadline; this contract has one window
    ///     of 30 minutes total, so in the exact case the ADR exists for — source
    ///     data missing — a 30-minute outage consumes the entire budget and the
    ///     market invalidates even if the data returns and quorum was reachable.
    ///
    /// Whichever way that is settled, it must not drift silently: this constant
    /// decides when a market stops being resolvable and becomes refundable.
    function testResolutionDeadlineIsThirtyMinutesFromDecisiveClose() public {
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);

        assertEq(
            market.resolutionDueAt(),
            uint64(block.timestamp + 30 minutes),
            "the resolution deadline is 30 minutes from the decisive close (see ADR 0011 and issue 10)"
        );

        // One second past it, no resolver can attest any longer...
        vm.warp(market.resolutionDueAt() + 1);
        vm.prank(resolver1);
        vm.expectRevert();
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, keccak256("evidence-v1"));

        // ...and the market is permissionlessly invalidated instead, which is
        // the fail-closed half: an unresolvable market refunds rather than
        // waiting for a quorum that is no longer allowed to form.
        market.invalidateUnresolved();
        assertEq(uint8(market.finalOutcome()), uint8(LivePredictionMarket.Outcome.Invalid));
    }

    /// Before the deadline, nobody may invalidate — otherwise anyone could race
    /// the resolvers and force a refund on a market that was about to settle.
    function testUnresolvedInvalidationIsRefusedBeforeTheDeadline() public {
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);

        vm.warp(market.resolutionDueAt() - 1);
        vm.expectRevert();
        market.invalidateUnresolved();
    }

    function testInitializationAndBondsFreezeCoreConfiguration() public view {
        assertEq(address(market.collateral()), address(usdc));
        assertEq(market.participantA(), participantA);
        assertEq(market.participantB(), participantB);
        assertEq(market.question(), "Will Nova win?");
        assertTrue(market.isReady());
        assertTrue(market.restrictedWallet(participantA));
        assertTrue(market.hasRole(market.GATE_ROLE(), gateOracle));
        assertFalse(market.hasRole(market.DEFAULT_ADMIN_ROLE(), address(this)), "market roles must be frozen");
    }

    function testPendingLiquidityChangesNoMarketStateUntilSafe() public {
        (uint64 epoch, uint256 actionId) = _submitLiquidity(lp1, 1_000 * U, 1_000 * U);
        assertEq(market.reserveA(), 0);
        assertEq(market.reserveB(), 0);
        assertEq(market.totalLpShares(), 0);
        assertEq(market.pendingCollateral(), 1_000 * U);

        _clear(epoch);
        (LivePredictionMarket.ActionKind kind, LivePredictionMarket.ActionStatus status,,,,,,,) =
            market.actions(actionId);
        assertEq(uint256(kind), uint256(LivePredictionMarket.ActionKind.AddLiquidity));
        assertEq(uint256(status), uint256(LivePredictionMarket.ActionStatus.Executed));
        assertEq(market.reserveA(), 1_000 * U);
        assertEq(market.reserveB(), 1_000 * U);
        assertEq(market.totalLpShares(), 1_000 * U);
        assertEq(market.collateralBacking(), 1_000 * U);
        assertEq(market.pendingCollateral(), 0);
    }

    function testBuySplitsBudgetAndPreservesBacking() public {
        _seed();
        MarketMath.BuyQuote memory quote = market.quoteBuy(true, 100 * U);
        uint256 oldProduct = market.reserveA() * market.reserveB();
        (uint64 epoch,) = _submitBuy(trader, true, 100 * U, quote.positionsOut);

        assertEq(market.positionAOf(trader), 0, "pending purchase cannot mint positions");
        assertEq(market.winnerRewardPool(), 0);
        _clear(epoch);

        assertEq(quote.tradeInput, 98_700_000);
        assertEq(quote.winnerRewardFee, 1_000_000);
        assertEq(quote.liquidityFee, 300_000);
        assertEq(market.positionAOf(trader), quote.positionsOut);
        assertEq(market.winnerRewardPool(), 1 * U);
        assertEq(market.unclaimedLpFees(), 300_000);
        assertEq(market.collateralBacking(), 1_098_700_000);
        assertGe(market.reserveA() * market.reserveB(), oldProduct);
        assertLe(market.accountedLiabilities(), usdc.balanceOf(address(market)));

        vm.prank(lp1);
        market.claimLpFees();
        assertEq(usdc.balanceOf(lp1), 19_000 * U + 300_000);
    }

    function testParticipantCannotForecastOrProvideLiquidity() public {
        _seed();
        vm.startPrank(participantA);
        usdc.approve(address(market), type(uint256).max);
        vm.expectRevert(LivePredictionMarket.NotEligible.selector);
        market.submitBuy(true, 10 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.expectRevert(LivePredictionMarket.NotEligible.selector);
        market.submitAddLiquidity(10 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function testLaterLiquidityPreservesPriceAndCannotClaimPastFees() public {
        _seed();
        (uint64 buyEpoch,) = _submitBuy(trader, true, 100 * U, 1);
        _clear(buyEpoch);
        uint256 priceBefore = market.spotPriceA();

        (uint64 liquidityEpoch,) = _submitLiquidity(lp2, 500 * U, 1);
        _clear(liquidityEpoch);
        uint256 priceAfter = market.spotPriceA();

        assertApproxEqAbs(priceAfter, priceBefore, 1);
        assertGt(market.positionAOf(lp2), 0, "later LP should receive adjustment inventory");
        vm.prank(lp2);
        vm.expectRevert(LivePredictionMarket.NothingToClaim.selector);
        market.claimLpFees();

        (uint64 laterBuyEpoch,) = _submitBuy(trader2, false, 50 * U, 1);
        _clear(laterBuyEpoch);
        vm.prank(lp2);
        market.claimLpFees();
        assertGt(usdc.balanceOf(lp2), 19_500 * U);
    }

    function testSellReturnsCollateralAndChargesOnlyLpFee() public {
        _seed();
        (uint64 buyEpoch,) = _submitBuy(trader, true, 100 * U, 1);
        _clear(buyEpoch);
        uint256 totalPositions = market.positionAOf(trader);
        uint256 positions = totalPositions / 2;
        MarketMath.SellQuote memory quote = market.quoteSell(true, positions);
        uint256 balanceBefore = usdc.balanceOf(trader);

        uint64 sellEpoch = market.currentEpoch();
        vm.prank(trader);
        market.submitSell(true, positions, quote.collateralOut, uint64(block.timestamp + 10 minutes));
        _clear(sellEpoch);

        assertEq(usdc.balanceOf(trader), balanceBefore + quote.collateralOut);
        assertEq(market.positionAOf(trader), totalPositions - positions);
        assertGt(quote.liquidityFee, 0);
    }

    function testMinimumOutputFailureRefundsWithoutFees() public {
        _seed();
        uint256 balanceBefore = usdc.balanceOf(trader);
        (uint64 epoch, uint256 actionId) = _submitBuy(trader, true, 100 * U, type(uint128).max);
        _clear(epoch);

        (, LivePredictionMarket.ActionStatus status,,,,,,,) = market.actions(actionId);
        assertEq(uint256(status), uint256(LivePredictionMarket.ActionStatus.Refunded));
        assertEq(usdc.balanceOf(trader), balanceBefore);
        assertEq(market.winnerRewardPool(), 0);
        assertEq(market.unclaimedLpFees(), 0);
    }

    function testDecisiveEventRefundsOverlappingEpochAndClosesPermanently() public {
        _seed();
        uint256 balanceBefore = usdc.balanceOf(trader);
        (uint64 epoch, uint256 actionId) = _submitBuy(trader, true, 100 * U, 1);
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        market.processEpoch(epoch, 10);

        (, LivePredictionMarket.ActionStatus status,,,,,,,) = market.actions(actionId);
        assertEq(uint256(status), uint256(LivePredictionMarket.ActionStatus.Refunded));
        assertEq(usdc.balanceOf(trader), balanceBefore);
        assertEq(uint256(market.gateState()), uint256(LivePredictionMarket.GateState.Closed));

        vm.startPrank(trader);
        usdc.approve(address(market), 10 * U);
        vm.expectRevert(LivePredictionMarket.InvalidState.selector);
        market.submitBuy(true, 10 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function testResolutionRedemptionWinnerRewardLpSettlementAndBondReturn() public {
        _seed();
        (uint64 epoch,) = _submitBuy(trader, true, 100 * U, 1);
        _clear(epoch);
        uint256 traderPositions = market.positionAOf(trader);
        _closeAndFinalize(LivePredictionMarket.Outcome.ParticipantA);

        uint256 traderBefore = usdc.balanceOf(trader);
        vm.prank(trader);
        market.redeemPositions();
        assertEq(usdc.balanceOf(trader), traderBefore + traderPositions);

        uint256 rewardBefore = usdc.balanceOf(participantA);
        vm.prank(participantA);
        market.claimWinnerReward();
        assertEq(usdc.balanceOf(participantA), rewardBefore + 1 * U);

        vm.prank(lp1);
        market.settleLpInventory();
        vm.prank(participantA);
        market.claimIntegrityBond();
        vm.prank(participantB);
        market.claimIntegrityBond();
        assertEq(market.totalIntegrityBondLiability(), 0);
        assertLe(market.accountedLiabilities(), usdc.balanceOf(address(market)));
    }

    function testAcceptedChallengeInvalidatesAndRefundsBondAndWinnerFee() public {
        _seed();
        (uint64 epoch,) = _submitBuy(trader, true, 100 * U, 1);
        _clear(epoch);
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        bytes32 evidence = keccak256("candidate");
        vm.prank(resolver1);
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, evidence);
        vm.prank(resolver2);
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, evidence);

        uint256 challengerBefore = usdc.balanceOf(challenger);
        vm.startPrank(challenger);
        usdc.approve(address(market), 10 * U);
        market.challengeResult(keccak256("contradiction"), 10 * U);
        vm.stopPrank();
        vm.prank(resolver1);
        market.attestChallengeVerdict(true);
        vm.prank(resolver3);
        market.attestChallengeVerdict(true);

        assertEq(uint256(market.finalOutcome()), uint256(LivePredictionMarket.Outcome.Invalid));
        assertEq(usdc.balanceOf(challenger), challengerBefore);
        uint256 traderBefore = usdc.balanceOf(trader);
        vm.prank(trader);
        market.claimInvalidWinnerFeeRefund();
        assertEq(usdc.balanceOf(trader), traderBefore + 1 * U);
    }

    /// What an Invalid market does with the two fees, pinned side by side.
    ///
    /// ADR 0013 recorded the Liquidity Fee treatment on an invalid market as
    /// "deliberately deferred and must be frozen before implementation". It was
    /// in fact already decided, in code, and the decision is a considered one —
    /// the two fees are treated DIFFERENTLY and on purpose:
    ///
    ///   - the 1% Winner Reward Fee is refunded (`claimInvalidWinnerFeeRefund`),
    ///     because it funded a winner reward that will never be paid;
    ///   - the 0.3% Liquidity Fee is kept, because it paid for liquidity that
    ///     was genuinely supplied and inventory risk that was genuinely borne,
    ///     neither of which the market's invalidity undoes.
    ///
    /// Asserting them together is the point. Either alone reads as an oversight;
    /// together they are a rule. The same rule must be disclosed to a refunded
    /// forecaster, which is a UI obligation rather than a contract one.
    function testInvalidMarketRefundsTheWinnerFeeAndRetainsTheLiquidityFee() public {
        _seed();
        (uint64 epoch,) = _submitBuy(trader, true, 100 * U, 1);
        _clear(epoch);

        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        vm.warp(market.resolutionDueAt() + 1);
        market.invalidateUnresolved();
        assertEq(uint8(market.finalOutcome()), uint8(LivePredictionMarket.Outcome.Invalid));

        // The winner-reward fee comes back to whoever paid it.
        uint256 traderBefore = usdc.balanceOf(trader);
        vm.prank(trader);
        market.claimInvalidWinnerFeeRefund();
        assertEq(usdc.balanceOf(trader), traderBefore + 1 * U, "the winner fee is refunded on Invalid");

        // The liquidity fee does not. The LP claims it in full, on a market that
        // resolved to nothing.
        uint256 lpBefore = usdc.balanceOf(lp1);
        vm.prank(lp1);
        market.claimLpFees();
        assertGt(usdc.balanceOf(lp1), lpBefore, "LP fees survive an Invalid settlement, by design");
    }

    function testChallengeRequiresFrozenBond() public {
        _seed();
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        bytes32 evidence = keccak256("candidate");
        vm.prank(resolver1);
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, evidence);
        vm.prank(resolver2);
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, evidence);

        vm.startPrank(challenger);
        usdc.approve(address(market), 10 * U);
        vm.expectRevert(LivePredictionMarket.InvalidState.selector);
        market.challengeResult(keccak256("cheap-spam"), 1);
        vm.stopPrank();
    }

    function testMissingResolverQuorumFailsClosedToInvalid() public {
        _seed();
        vm.prank(gateOracle);
        market.closeForDecisiveEvent(nextSequence++);
        vm.warp(market.resolutionDueAt() + 1);
        vm.prank(resolver1);
        vm.expectRevert(LivePredictionMarket.InvalidState.selector);
        market.attestResult(LivePredictionMarket.Outcome.ParticipantA, keccak256("late"));
        market.invalidateUnresolved();
        assertEq(uint256(market.finalOutcome()), uint256(LivePredictionMarket.Outcome.Invalid));
    }

    function testFuzzBuyQuotePreservesInvariant(uint96 rawBudget) public {
        _seed();
        uint256 budget = bound(uint256(rawBudget), 1 * U, 1_000_000 * U);
        MarketMath.BuyQuote memory quote = market.quoteBuy(true, budget);
        assertGt(quote.positionsOut, 0);
        assertGe(quote.newSelectedReserve * quote.newOtherReserve, market.reserveA() * market.reserveB());
        assertEq(quote.tradeInput + quote.winnerRewardFee + quote.liquidityFee, budget);
    }

    // ------------------------------------------ execution after every LP settles

    /// An epoch cleared but never processed, executed after the LPs have gone.
    ///
    /// `settleLpInventory` takes the shares and the reserves to zero. The epoch
    /// queue is permissionless by design, so anyone can then push the stale
    /// epoch through — and the buy inside it reaches `_distributeLpFee`, which
    /// divides the fee by a share supply of zero and panics. Not a revert with a
    /// reason: an arithmetic panic, on every subsequent call, forever. Anything
    /// still queued behind that epoch can never be executed or refunded.
    function testAnEpochExecutedAfterEveryLpSettlesDoesNotPanic() public {
        _seed();
        // A deadline that never expires, so the action is still live when the
        // stale epoch is finally pushed through: the refund path that would
        // otherwise catch it does not apply.
        uint64 epoch = market.currentEpoch();
        vm.startPrank(trader);
        usdc.approve(address(market), 500 * U);
        market.submitBuy(true, 500 * U, 1, type(uint64).max);
        vm.stopPrank();

        // The epoch is marked safe, but the processing call never lands.
        uint256 readyAt = market.epochEndsAt(epoch) + market.sourceFinalityDelay();
        if (block.timestamp < readyAt) vm.warp(readyAt);
        vm.prank(gateOracle);
        market.markEpochSafe(epoch, nextSequence++);

        _closeAndFinalize(LivePredictionMarket.Outcome.ParticipantA);

        vm.prank(lp1);
        market.settleLpInventory();
        assertEq(market.totalLpShares(), 0, "every LP has settled");

        // A keeper pushes the stale epoch through. Permissionless by design.
        market.processEpoch(epoch, type(uint256).max);

        // The fee had nowhere to go per share, so it stays with the market's
        // collateral rather than panicking or vanishing.
        assertEq(market.totalLpShares(), 0);
        assertGt(market.positionAOf(trader), 0, "the trade executed");
    }

    /// Liquidity that lands after its provider has already settled.
    ///
    /// An epoch marked safe but never processed can be pushed through after the
    /// market is final. If that epoch holds an AddLiquidity, the provider is
    /// minted fresh shares — and `settleLpInventory` refused them, because a
    /// flag set by their first settlement barred the second forever. Their
    /// collateral went in, `redeemPositions` pays nothing for it, and the only
    /// exit was closed. The `shares == 0` guard already prevents double
    /// settlement; the flag only prevented recovery.
    function testLiquidityMintedAfterSettlementCanStillBeRecovered() public {
        _seed();

        // A second commitment from lp1, in an epoch that is cleared but whose
        // processing call never lands.
        uint64 epoch = market.currentEpoch();
        vm.startPrank(lp1);
        usdc.approve(address(market), 500 * U);
        market.submitAddLiquidity(500 * U, 1, type(uint64).max);
        vm.stopPrank();
        uint256 readyAt = market.epochEndsAt(epoch) + market.sourceFinalityDelay();
        if (block.timestamp < readyAt) vm.warp(readyAt);
        vm.prank(gateOracle);
        market.markEpochSafe(epoch, nextSequence++);

        _closeAndFinalize(LivePredictionMarket.Outcome.ParticipantA);

        vm.prank(lp1);
        market.settleLpInventory();

        // A keeper finally pushes the stale epoch through, minting lp1 shares.
        market.processEpoch(epoch, type(uint256).max);
        assertGt(market.lpSharesOf(lp1), 0, "the late commitment minted shares");

        uint256 before = usdc.balanceOf(lp1);
        vm.prank(lp1);
        market.settleLpInventory();
        assertGt(usdc.balanceOf(lp1), before, "and those shares must still be redeemable");
        assertEq(market.lpSharesOf(lp1), 0);
    }
}
