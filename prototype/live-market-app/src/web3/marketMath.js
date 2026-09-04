/** Collateral is USDC: six decimals, held as BigInt everywhere but the input. */
const USDC_DECIMALS = 6n;
const USDC_UNIT = 10n ** USDC_DECIMALS;

export function toUsdc(value) {
  const amount = BigInt(value || 0n);
  return Number(amount) / Number(USDC_UNIT);
}

/**
 * A decimal amount as collateral units.
 *
 * `String(0.0000001)` is "1e-7", which a units parser rejects — and the trade
 * sheet then reported a fully-read market as unquotable and hid its own amount
 * field. Fixing the notation at the collateral's own precision avoids both the
 * exponent form and any float tail beyond six decimals.
 */
export function fromUsdc(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const [whole, fraction = ""] = amount.toFixed(Number(USDC_DECIMALS)).split(".");
  return BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(Number(USDC_DECIMALS), "0"));
}

/**
 * @param winnerRewardBps the market's own winning-participant rate.
 *
 * Per-market, and zero is a valid configuration — the contract only rejects
 * values above MAX_WINNER_REWARD_BPS. Hardcoding 1% here understated
 * `tradeInput` on any other market, so the position count the interface shows
 * as "Estimated payout if correct" was wrong on the real reserve path, and the
 * summary charged a fee the contract does not.
 */
export function quoteBuy(reserveA, reserveB, participantAOutcome, budget, winnerRewardBps) {
  if (winnerRewardBps === undefined || winnerRewardBps === null) {
    throw new Error("quoteBuy needs the market's winnerRewardBps: it is per-market and cannot be assumed");
  }
  const winnerRewardFee = (budget * BigInt(winnerRewardBps)) / 10_000n;
  const liquidityFee = budget * 30n / 10_000n;
  const tradeInput = budget - winnerRewardFee - liquidityFee;
  const selected = participantAOutcome ? reserveA : reserveB;
  const other = participantAOutcome ? reserveB : reserveA;
  const newOther = other + tradeInput;
  const product = selected * other;
  const newSelected = (product + newOther - 1n) / newOther;
  const positionsOut = selected + tradeInput - newSelected;
  return { winnerRewardFee, liquidityFee, tradeInput, positionsOut, newSelected, newOther };
}

function sqrtFloor(value) {
  if (value < 0n) throw new Error("Cannot calculate a square root for a negative value.");
  if (value < 2n) return value;
  let x = value;
  let next = (x + value / x) / 2n;
  while (next < x) {
    x = next;
    next = (x + value / x) / 2n;
  }
  return x;
}

export function quoteSell(reserveA, reserveB, participantAOutcome, positionsIn) {
  const selected = participantAOutcome ? reserveA : reserveB;
  const other = participantAOutcome ? reserveB : reserveA;
  const sum = selected + positionsIn + other;
  const discriminant = sum * sum - 4n * positionsIn * other;
  const floorRoot = sqrtFloor(discriminant);
  const root = floorRoot * floorRoot === discriminant ? floorRoot : floorRoot + 1n;
  const grossCollateral = (sum - root) / 2n;
  const liquidityFee = grossCollateral * 30n / 10_000n;
  const collateralOut = grossCollateral - liquidityFee;
  const newSelected = selected + positionsIn - grossCollateral;
  const newOther = other - grossCollateral;
  return { grossCollateral, liquidityFee, collateralOut, newSelected, newOther };
}
