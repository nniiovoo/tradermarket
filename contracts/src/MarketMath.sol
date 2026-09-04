// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Conservative fixed-product calculations used by every Competition Market.
library MarketMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_WINNER_REWARD_BPS = 100;
    uint256 internal constant LIQUIDITY_FEE_BPS = 30;

    struct BuyQuote {
        uint256 tradeInput;
        uint256 winnerRewardFee;
        uint256 liquidityFee;
        uint256 positionsOut;
        uint256 newSelectedReserve;
        uint256 newOtherReserve;
    }

    struct SellQuote {
        uint256 grossCollateral;
        uint256 liquidityFee;
        uint256 collateralOut;
        uint256 newSelectedReserve;
        uint256 newOtherReserve;
    }

    function quoteBuy(uint256 selectedReserve, uint256 otherReserve, uint256 budget, uint256 winnerRewardBps)
        internal
        pure
        returns (BuyQuote memory quote)
    {
        quote.winnerRewardFee = Math.mulDiv(budget, winnerRewardBps, BPS);
        quote.liquidityFee = Math.mulDiv(budget, LIQUIDITY_FEE_BPS, BPS);
        quote.tradeInput = budget - quote.winnerRewardFee - quote.liquidityFee;

        quote.newOtherReserve = otherReserve + quote.tradeInput;
        quote.newSelectedReserve = Math.mulDiv(selectedReserve, otherReserve, quote.newOtherReserve, Math.Rounding.Ceil);
        quote.positionsOut = selectedReserve + quote.tradeInput - quote.newSelectedReserve;
    }

    function quoteSell(uint256 selectedReserve, uint256 otherReserve, uint256 positionsIn)
        internal
        pure
        returns (SellQuote memory quote)
    {
        uint256 sum = selectedReserve + positionsIn + otherReserve;
        uint256 discriminant = (sum * sum) - (4 * positionsIn * otherReserve);
        uint256 root = Math.sqrt(discriminant, Math.Rounding.Ceil);

        quote.grossCollateral = (sum - root) / 2;
        quote.liquidityFee = Math.mulDiv(quote.grossCollateral, LIQUIDITY_FEE_BPS, BPS);
        quote.collateralOut = quote.grossCollateral - quote.liquidityFee;
        quote.newSelectedReserve = selectedReserve + positionsIn - quote.grossCollateral;
        quote.newOtherReserve = otherReserve - quote.grossCollateral;
    }

    function spotPriceA(uint256 reserveA, uint256 reserveB) internal pure returns (uint256) {
        uint256 total = reserveA + reserveB;
        if (total == 0) return 500_000;
        return Math.mulDiv(reserveB, 1_000_000, total);
    }
}
