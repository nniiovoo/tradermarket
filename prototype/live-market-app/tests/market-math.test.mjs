import assert from "node:assert/strict";
import test from "node:test";
import { quoteBuy, quoteSell } from "../src/web3/marketMath.js";

const U = 1_000_000n;

test("buy quote matches the frozen fee split and conserves the invariant", () => {
  const quote = quoteBuy(1_000n * U, 1_000n * U, true, 100n * U, 100n);
  assert.equal(quote.winnerRewardFee, 1n * U);
  assert.equal(quote.liquidityFee, 300_000n);
  assert.equal(quote.tradeInput, 98_700_000n);
  assert.ok(quote.positionsOut > 0n);
  assert.ok(quote.newSelected * quote.newOther >= 1_000n * U * 1_000n * U);
});

test("outcome direction is symmetric when the reserve inputs are swapped", () => {
  const buyA = quoteBuy(800n * U, 1_250n * U, true, 25n * U, 100n);
  const buyBWithSwappedReserves = quoteBuy(1_250n * U, 800n * U, false, 25n * U, 100n);
  assert.deepEqual(buyA, buyBWithSwappedReserves);
});

test("sell quote deducts exactly the LP fee and preserves backing math", () => {
  const reserveA = 800n * U;
  const reserveB = 1_250n * U;
  const quote = quoteSell(reserveA, reserveB, true, 50n * U);
  assert.equal(quote.liquidityFee, quote.grossCollateral * 30n / 10_000n);
  assert.equal(quote.collateralOut, quote.grossCollateral - quote.liquidityFee);
  assert.ok(quote.collateralOut > 0n);
  assert.ok(quote.newSelected * quote.newOther >= reserveA * reserveB);
});

test("quoteBuy charges the market's own winning-participant rate", () => {
  // `winnerRewardBps` is per-market and zero is a valid configuration
  // (LivePredictionMarket only rejects values above MAX_WINNER_REWARD_BPS). A
  // hardcoded 1% understates `tradeInput` on a zero-bps market, so the position
  // count — rendered as "Estimated payout if correct" — is wrong on the real
  // reserve path too, and the summary charges a fee the contract does not.
  const reserveA = 1_000_000_000n;
  const reserveB = 1_000_000_000n;
  const budget = 100_000_000n;

  const onePercent = quoteBuy(reserveA, reserveB, true, budget, 100n);
  assert.equal(onePercent.winnerRewardFee, 1_000_000n);

  const free = quoteBuy(reserveA, reserveB, true, budget, 0n);
  assert.equal(free.winnerRewardFee, 0n, "a zero-bps market charges nothing");
  assert.ok(free.tradeInput > onePercent.tradeInput, "and therefore buys more");
  assert.ok(free.positionsOut > onePercent.positionsOut);

  // The liquidity fee is a protocol constant and stays at 30 bps either way.
  assert.equal(free.liquidityFee, onePercent.liquidityFee);
});

test("a decimal amount is converted whatever notation JavaScript prints it in", async () => {
  const { fromUsdc } = await import("../src/web3/marketMath.js");

  // `String(0.0000001)` is "1e-7", which parseUnits rejects. The trade sheet
  // then caught the throw, reported the market as unquotable, and the amount
  // field disappeared — on a market whose reserves had been read perfectly.
  assert.equal(fromUsdc(1), 1_000_000n);
  assert.equal(fromUsdc(0.5), 500_000n);
  assert.equal(fromUsdc("25.25"), 25_250_000n);
  assert.equal(fromUsdc(0), 0n);
  assert.equal(fromUsdc(1e-7), 0n, "below the smallest unit is zero, not a throw");
  assert.equal(fromUsdc(1.2e2), 120_000_000n, "large-exponent notation converts too");
});
