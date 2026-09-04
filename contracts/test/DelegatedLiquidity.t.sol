// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LivePredictionMarket} from "../src/LivePredictionMarket.sol";
import {LiveMarketFactory} from "../src/LiveMarketFactory.sol";
import {LiveRoom} from "../src/LiveRoom.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Issue 15: submitAddLiquidityFor behind a frozen LIQUIDITY_ROUTER_ROLE.
contract DelegatedLiquidityTest is Test {
    uint256 private constant U = 1e6;

    MockUSDC internal usdc;
    LivePredictionMarket internal market;
    LiveMarketFactory internal factory;

    address internal participantA = makeAddr("participantA");
    address internal participantB = makeAddr("participantB");
    address internal gateOracle = makeAddr("gateOracle");
    address internal resolver1 = makeAddr("resolver1");
    address internal resolver2 = makeAddr("resolver2");
    address internal resolver3 = makeAddr("resolver3");
    address internal bondRecipient = makeAddr("bondRecipient");
    address internal router = makeAddr("router");
    address internal outsider = makeAddr("outsider");
    address internal lp = makeAddr("lp");

    uint256 internal nextSequence = 1;

    function setUp() public {
        usdc = new MockUSDC();
        LivePredictionMarket implementation = new LivePredictionMarket();
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
            roomId: bytes32("room-1"),
            slotIndex: 0,
            templateId: bytes32("tpl"),
            conditionHash: keccak256("condition"),
            winnerRewardBps: 100,
            opensAt: 0,
            readinessSource: address(0),
            liquidityRouter: router,
            participantAName: "Nova",
            participantBName: "Arc",
            question: "Will Nova win?",
            streamUrl: "https://example.com/live",
            imageUrl: ""
        });
        address[] memory restricted = new address[](0);
        market = LivePredictionMarket(factory.createMarket(config, restricted));

        usdc.mint(participantA, 1_000 * U);
        usdc.mint(participantB, 1_000 * U);
        usdc.mint(router, 10_000 * U);
        usdc.mint(lp, 10_000 * U);
        usdc.mint(outsider, 10_000 * U);
        vm.startPrank(participantA);
        usdc.approve(address(market), 100 * U);
        market.postIntegrityBond();
        vm.stopPrank();
        vm.startPrank(participantB);
        usdc.approve(address(market), 100 * U);
        market.postIntegrityBond();
        vm.stopPrank();
    }

    function _clear(uint64 epoch) internal {
        uint256 readyAt = market.epochEndsAt(epoch) + market.sourceFinalityDelay();
        if (block.timestamp < readyAt) vm.warp(readyAt);
        vm.prank(gateOracle);
        market.markEpochSafe(epoch, nextSequence++);
        market.processEpoch(epoch, type(uint256).max);
    }

    function testRouterRoleGrantedAndRouterRestricted() public view {
        assertTrue(market.hasRole(market.LIQUIDITY_ROUTER_ROLE(), router));
        assertTrue(market.restrictedWallet(router), "router cannot hold its own positions");
    }

    function testDelegatedLiquidityCreditsProviderNotRouter() public {
        uint64 epoch = market.currentEpoch();
        vm.startPrank(router);
        usdc.approve(address(market), 1_000 * U);
        market.submitAddLiquidityFor(lp, 1_000 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(epoch);

        assertEq(market.lpSharesOf(lp), 1_000 * U, "shares belong to the provider");
        assertEq(market.lpSharesOf(router), 0, "router accumulates nothing");
        assertEq(market.totalLpShares(), 1_000 * U);
    }

    function testDelegatedRefundGoesToProvider() public {
        // Seed first so a later delegated deposit can fail its minimum-shares check.
        uint64 seedEpoch = market.currentEpoch();
        vm.startPrank(lp);
        usdc.approve(address(market), 1_000 * U);
        market.submitAddLiquidity(1_000 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(seedEpoch);

        uint256 lpBefore = usdc.balanceOf(lp);
        uint256 routerBefore = usdc.balanceOf(router);
        uint64 epoch = market.currentEpoch();
        vm.startPrank(router);
        usdc.approve(address(market), 100 * U);
        market.submitAddLiquidityFor(lp, 100 * U, type(uint128).max, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
        _clear(epoch);

        assertEq(usdc.balanceOf(lp), lpBefore + 100 * U, "refund lands on the provider");
        assertEq(usdc.balanceOf(router), routerBefore - 100 * U, "router paid the escrow");
    }

    function testNonRouterCannotDelegate() public {
        vm.startPrank(outsider);
        usdc.approve(address(market), 100 * U);
        vm.expectRevert();
        market.submitAddLiquidityFor(lp, 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function testRestrictedProviderRejectedThroughRouter() public {
        vm.startPrank(router);
        usdc.approve(address(market), 100 * U);
        vm.expectRevert(LivePredictionMarket.NotEligible.selector);
        market.submitAddLiquidityFor(participantA, 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.expectRevert(LivePredictionMarket.NotEligible.selector);
        market.submitAddLiquidityFor(router, 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.expectRevert(LivePredictionMarket.NotEligible.selector);
        market.submitAddLiquidityFor(address(0), 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function testAmountBoundsApplyThroughRouter() public {
        vm.startPrank(router);
        usdc.approve(address(market), type(uint256).max);
        vm.expectRevert(LivePredictionMarket.InvalidAmount.selector);
        market.submitAddLiquidityFor(lp, 1, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }

    function testStandalonePathUnchangedWithoutRouter() public {
        // A market with no configured router has no member of the role.
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
            question: "Standalone",
            streamUrl: "",
            imageUrl: ""
        });
        address[] memory restricted = new address[](0);
        LivePredictionMarket standalone = LivePredictionMarket(factory.createMarket(config, restricted));
        vm.startPrank(router);
        usdc.approve(address(standalone), 100 * U);
        vm.expectRevert();
        standalone.submitAddLiquidityFor(lp, 100 * U, 1, uint64(block.timestamp + 10 minutes));
        vm.stopPrank();
    }
}
