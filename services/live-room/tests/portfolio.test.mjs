// P1 portfolio and history.
//
// The report's gap: "no complete transaction, prediction, payout or
// settlement-history journey". These tests define what complete means here —
// every figure traceable to an indexed chain fact, nothing modelled, nothing
// projected. In particular an open position is never shown as a payout, and an
// invalid market is never presented as a loss.

import test from "node:test";
import assert from "node:assert/strict";

import { ProjectionStore } from "../src/indexer/projection.mjs";
import { Portfolio } from "../src/discovery/portfolio.mjs";

/** A reader that reports the real balances of an account owed nothing. */
function zeroBalances() {
  return { async readAccountState() { return { lpFeeCredit: 0n, winnerFeePaid: 0n }; } };
}

const ME = "0xF0RECASTER";
const OPEN = "0xMARKET0PEN";
const WON = "0xMARKETW0N";
const VOID = "0xMARKETV01D";

function seeded() {
  const store = new ProjectionStore();

  store.upsertMarket({
    market_address: OPEN,
    room_id: "room-1",
    slot_index: 1,
    question: "Does alice reach 12,000 before the round ends?",
    final_outcome: 0,
    gate_state: 0,
    implied_prob_a: 620_000n,
    block_number: 10,
  });
  store.upsertMarket({
    market_address: WON,
    room_id: "room-1",
    slot_index: 2,
    question: "Does bob close green?",
    final_outcome: 1,
    gate_state: 2,
    block_number: 20,
  });
  store.upsertMarket({
    market_address: VOID,
    room_id: "room-1",
    slot_index: 3,
    question: "Does the feed recover in time?",
    final_outcome: 4,
    gate_state: 2,
    block_number: 30,
  });

  // Open: bought outcome A, still holding.
  store.appendTrade({
    market_address: OPEN,
    account: ME,
    outcome_a: true,
    is_buy: true,
    amount_in: 25_000_000n,
    amount_out: 40_000_000n,
    block_number: 11,
  });
  store.adjustHolding(OPEN, ME, { position_a: 40_000_000n }, 11);

  // Won, and already redeemed.
  store.appendTrade({
    market_address: WON,
    account: ME,
    outcome_a: true,
    is_buy: true,
    amount_in: 10_000_000n,
    amount_out: 18_000_000n,
    block_number: 21,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "redeem", amount: 18_000_000n, block_number: 22 });

  // Invalid, holding never redeemed: a refund is still waiting.
  store.adjustHolding(VOID, ME, { position_b: 12_000_000n }, 31);
  store.appendClaim({
    market_address: VOID,
    account: ME,
    kind: "winner_fee_refund",
    amount: 100_000n,
    block_number: 32,
  });

  // LP position on the open market, plus a fee claim.
  store.adjustHolding(OPEN, ME, { lp_shares: 5_000_000n }, 12);
  store.appendClaim({ market_address: OPEN, account: ME, kind: "lp_fees", amount: 300_000n, block_number: 13 });

  return store;
}

test("open predictions are listed as positions, never as payouts", async () => {
  const portfolio = new Portfolio({ store: seeded(), accountReader: zeroBalances() });
  const view = await portfolio.of(ME);

  const open = view.predictions.open;
  assert.equal(open.length, 1);
  assert.equal(open[0].market, OPEN.toLowerCase());
  assert.equal(open[0].side, "outcome_a");
  assert.equal(open[0].size, 40_000_000n);
  assert.equal(open[0].question, "Does alice reach 12,000 before the round ends?");
  assert.ok(!("payout" in open[0]), "an unresolved position has no payout");
  assert.ok(!("profit" in open[0]), "an unresolved position has no profit figure");
  assert.match(view.predictions.open_note, /not a payout|has not settled/i);
});

test("settled predictions separate what was claimed from what is still claimable", async () => {
  const portfolio = new Portfolio({ store: seeded(), accountReader: zeroBalances() });
  const view = await portfolio.of(ME);

  const settled = view.predictions.settled;
  const won = settled.find((row) => row.market === WON.toLowerCase());
  assert.equal(won.outcome_label, "outcome_a");
  assert.equal(won.claimed, 18_000_000n);
  assert.equal(won.claimable, false, "a redeemed position is not still claimable");

  const invalid = settled.find((row) => row.market === VOID.toLowerCase());
  assert.equal(invalid.outcome_label, "invalid");
  assert.equal(invalid.claimable, true, "an unredeemed invalid-market position is a waiting refund");
  assert.match(invalid.detail, /invalid/i);
  assert.match(invalid.detail, /return|refund/i);
});

test("transaction history merges trades and claims in chain order", async () => {
  const portfolio = new Portfolio({ store: seeded(), accountReader: zeroBalances() });
  const rows = (await portfolio.of(ME)).transactions;

  assert.deepEqual(
    rows.map((row) => row.block_number),
    [32, 22, 21, 13, 11],
    "history is newest first and includes both trades and claims"
  );
  assert.equal(rows.at(-1).type, "trade");
  assert.equal(rows[0].type, "claim");
  for (const row of rows) {
    assert.ok(row.market, "every row names its market");
    assert.ok(typeof row.summary === "string" && row.summary.length > 0);
  }
});

test("payout history totals only what the chain actually credited", async () => {
  const portfolio = new Portfolio({ store: seeded(), accountReader: zeroBalances() });
  const view = await portfolio.of(ME);

  assert.equal(view.payouts.total_credited, 18_400_000n);
  const kinds = Object.fromEntries(view.payouts.by_kind.map((row) => [row.kind, row.amount]));
  assert.equal(kinds.redeem, 18_000_000n);
  assert.equal(kinds.lp_fees, 300_000n);
  assert.equal(kinds.winner_fee_refund, 100_000n);
  assert.equal(view.payouts.by_kind.every((row) => row.label && row.label.length > 0), true);
});

test("liquidity positions are reported separately from predictions", async () => {
  const view = await new Portfolio({ store: seeded(), accountReader: zeroBalances() }).of(ME);
  assert.equal(view.liquidity.positions.length, 1);
  assert.equal(view.liquidity.positions[0].lp_shares, 5_000_000n);
  assert.equal(view.liquidity.fees_claimed, 300_000n);
  assert.match(view.liquidity.note, /0\.3%|inventory risk/i);
});

test("an account with no history gets an explanation, not an empty screen", async () => {
  const view = await new Portfolio({ store: new ProjectionStore(), accountReader: zeroBalances() }).of("0xNOBODY");
  assert.deepEqual(view.predictions.open, []);
  assert.deepEqual(view.transactions, []);
  assert.equal(view.payouts.total_credited, 0n);
  assert.match(view.empty_reason, /no .*(activity|position|trade)/i);
});

test("a losing position is not a waiting payout", async () => {
  // redeemPositions pays _resolvedValue(amountA, amountB), which is zero for a
  // purely losing holder — so nobody redeems and the holding survives on chain
  // forever. Calling that "claimable" shows someone who lost every market a
  // portfolio full of green claim prompts.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Does bob close green?", final_outcome: 1, block_number: 20,
  });
  store.adjustHolding(WON, ME, { position_b: 500_000_000n }, 21);

  const settled = (await new Portfolio({ store, accountReader: zeroBalances() }).of(ME)).predictions.settled;
  const row = settled.find((entry) => entry.market === WON.toLowerCase());

  assert.equal(row.claimable, false, "the losing side has nothing to claim");
  assert.match(row.detail, /did not win|nothing to claim|lost/i);
  assert.equal((await new Portfolio({ store, accountReader: zeroBalances() }).of(ME)).predictions.claimable_count, 0);
});

test("the winning side of a resolved market is claimable", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Does bob close green?", final_outcome: 1, block_number: 20,
  });
  store.adjustHolding(WON, ME, { position_a: 500_000_000n }, 21);

  const row = (await new Portfolio({ store, accountReader: zeroBalances() }).of(ME)).predictions.settled[0];
  assert.equal(row.claimable, true);
});

test("both sides are claimable on a tie and on an invalid market", async () => {
  for (const [outcome, label] of [[3, "tie"], [4, "invalid"]]) {
    const store = new ProjectionStore();
    store.upsertMarket({
      market_address: WON, room_id: "room-1", slot_index: 2,
      question: "Q", final_outcome: outcome, block_number: 20,
    });
    store.adjustHolding(WON, ME, { position_b: 500_000_000n }, 21);

    const row = (await new Portfolio({ store, accountReader: zeroBalances() }).of(ME)).predictions.settled[0];
    assert.equal(row.outcome_label, label);
    assert.equal(row.claimable, true, `${label} returns collateral to both sides`);
  }
});

test("an LP position on a settled market is claimable whichever side won", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 20,
  });
  // LP inventory settles regardless of outcome, and LP fees are owed either way.
  store.adjustHolding(WON, ME, { lp_shares: 5_000_000n }, 21);

  const row = (await new Portfolio({ store, accountReader: zeroBalances() }).of(ME)).predictions.settled[0];
  assert.equal(row.claimable, true, "LP inventory still settles");
});

test("an invalid market's winner-fee refund is claimable after redeeming", async () => {
  // claimInvalidWinnerFeeRefund is gated on winnerFeePaid > 0 alone — no
  // surviving position, no LP shares. It is a *second* transaction after
  // redeeming, so the common case is exactly the one that used to read as
  // settled: positions already redeemed, refund still waiting.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: VOID, room_id: "room-1", slot_index: 3,
    question: "Does the feed recover in time?", final_outcome: 4, block_number: 30,
  });
  store.appendTrade({
    market_address: VOID, account: ME, outcome_a: true, is_buy: true,
    amount_in: 20_000_000n, amount_out: 30_000_000n, block_number: 31,
  });
  store.appendClaim({ market_address: VOID, account: ME, kind: "redeem", amount: 15_000_000n, block_number: 32 });

  const paidTheFee = {
    async readAccountState() {
      return { lpFeeCredit: 0n, winnerFeePaid: 200_000n };
    },
  };
  const row = (await new Portfolio({ store, accountReader: paidTheFee }).of(ME)).predictions.settled.find((r) => r.market === VOID.toLowerCase());
  assert.equal(row.claimable, true, "the winner-fee refund has not been claimed yet");
  assert.ok(!/was refunded/.test(row.detail), `the detail must not assert a refund that has not happened: ${row.detail}`);
  assert.match(row.detail, /refund/i);
});

test("once refunded, the invalid market is settled", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: VOID, room_id: "room-1", slot_index: 3,
    question: "Q", final_outcome: 4, block_number: 30,
  });
  store.appendTrade({
    market_address: VOID, account: ME, outcome_a: true, is_buy: true,
    amount_in: 20_000_000n, amount_out: 30_000_000n, block_number: 31,
  });
  store.appendClaim({ market_address: VOID, account: ME, kind: "redeem", amount: 15_000_000n, block_number: 32 });
  store.appendClaim({ market_address: VOID, account: ME, kind: "winner_fee_refund", amount: 200_000n, block_number: 33 });

  const row = (await new Portfolio({ store, accountReader: zeroBalances() }).of(ME)).predictions.settled.find((r) => r.market === VOID.toLowerCase());
  assert.equal(row.claimable, false);
  assert.match(row.detail, /refunded/i);
});

test("LP fees survive inventory settlement and are still claimable", async () => {
  const feeCreditWaiting = {
    async readAccountState() {
      return { lpFeeCredit: 300_000n, winnerFeePaid: 0n };
    },
  };
  // settleLpInventory accrues into lpFeeCredit and zeroes lpSharesOf, but never
  // zeroes the credit. A settled LP therefore has no shares and real USDC
  // waiting, which a shares-only test reads as nothing to claim.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 20,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "lp_inventory", amount: 9_000_000n, block_number: 21 });

  const row = (await new Portfolio({ store, accountReader: feeCreditWaiting }).of(ME)).predictions.settled.find((r) => r.market === WON.toLowerCase());
  assert.equal(row.claimable, true, "LP fees are claimed separately from inventory");
  assert.match(row.detail, /fee/i);
});

test("an LP who has claimed both inventory and fees is settled", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 20,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "lp_inventory", amount: 9_000_000n, block_number: 21 });
  store.appendClaim({ market_address: WON, account: ME, kind: "lp_fees", amount: 300_000n, block_number: 22 });

  const row = (await new Portfolio({ store, accountReader: zeroBalances() }).of(ME)).predictions.settled.find((r) => r.market === WON.toLowerCase());
  assert.equal(row.claimable, false);
});

// ---------------------------------------------------------------------------
// Claimability read from the chain, not inferred from event history.
//
// `lpFeeCredit` and `winnerFeePaid` are per-account balances the contract
// exposes as public getters. Inferring them from claim events cannot work:
// `settleLpInventory` accrues into `lpFeeCredit` without paying it, so "has
// claimed fees once" says nothing about now; and `winnerFeePaid` only accrues
// when the market charges a fee, which is a per-market rate that may be zero.

/** A reader over the two per-account balances that decide what is still owed. */
function accountReader(balances) {
  return {
    async readAccountState(market, account) {
      const key = `${String(market).toLowerCase()}:${String(account).toLowerCase()}`;
      return balances[key] ?? { lpFeeCredit: 0n, winnerFeePaid: 0n };
    },
  };
}

test("an LP who claimed fees mid-market and then settled is still owed the accrual", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 40,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "lp_fees", amount: 3n, block_number: 20 });
  store.appendClaim({ market_address: WON, account: ME, kind: "lp_inventory", amount: 7n, block_number: 31 });

  const reader = accountReader({
    [`${WON.toLowerCase()}:${ME.toLowerCase()}`]: { lpFeeCredit: 4_000_000n, winnerFeePaid: 0n },
  });
  const view = await new Portfolio({ store, accountReader: reader }).of(ME);
  const row = view.predictions.settled.find((r) => r.market === WON.toLowerCase());

  assert.equal(row.claimable, true, "settlement accrues into the fee credit without paying it");
  assert.equal(row.owed.lp_fees, 4_000_000n, "and the amount is read, not guessed");
});

test("an LP with no fee credit is not told there is one waiting", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 40,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "lp_inventory", amount: 5n, block_number: 31 });

  const view = await new Portfolio({ store, accountReader: accountReader({}) }).of(ME);
  const row = view.predictions.settled.find((r) => r.market === WON.toLowerCase());

  assert.equal(row.claimable, false, "claimLpFees would revert with NothingToClaim");
  assert.equal(view.predictions.claimable_count, 0);
});

test("an invalid market that charged no winner fee has no refund to offer", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: VOID, room_id: "room-1", slot_index: 3,
    question: "Q", final_outcome: 4, winner_reward_bps: 0, block_number: 30,
  });
  store.appendTrade({
    market_address: VOID, account: ME, outcome_a: true, is_buy: true,
    amount_in: 10_000_000n, amount_out: 20_000_000n, block_number: 31,
  });
  store.appendClaim({ market_address: VOID, account: ME, kind: "redeem", amount: 10_000_000n, block_number: 32 });

  const view = await new Portfolio({ store, accountReader: accountReader({}) }).of(ME);
  const row = view.predictions.settled.find((r) => r.market === VOID.toLowerCase());

  assert.equal(row.claimable, false, "claimInvalidWinnerFeeRefund would revert");
  assert.ok(!/1%/.test(row.detail), `the copy must not name a rate this market did not charge: ${row.detail}`);
});

test("an invalid market that did charge a fee offers the refund at its real rate", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: VOID, room_id: "room-1", slot_index: 3,
    question: "Q", final_outcome: 4, winner_reward_bps: 100, block_number: 30,
  });
  store.appendTrade({
    market_address: VOID, account: ME, outcome_a: true, is_buy: true,
    amount_in: 10_000_000n, amount_out: 20_000_000n, block_number: 31,
  });

  const reader = accountReader({
    [`${VOID.toLowerCase()}:${ME.toLowerCase()}`]: { lpFeeCredit: 0n, winnerFeePaid: 100_000n },
  });
  const view = await new Portfolio({ store, accountReader: reader }).of(ME);
  const row = view.predictions.settled.find((r) => r.market === VOID.toLowerCase());

  assert.equal(row.claimable, true);
  assert.equal(row.owed.winner_fee_refund, 100_000n);
  assert.match(row.detail, /1%/, "the real rate is 100 bps here");
});

test("without a chain reader the portfolio says it cannot see the balances", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 40,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "lp_inventory", amount: 5n, block_number: 31 });

  // No reader configured: these balances are per-account and no event carries
  // them, so the honest answer is "not known", never "nothing owed".
  const view = await new Portfolio({ store }).of(ME);
  const row = view.predictions.settled.find((r) => r.market === WON.toLowerCase());

  assert.equal(row.claimable, null, "unknown is not false");
  assert.match(row.detail, /cannot|not known|unable/i);
});

// ---------------------------------------------------------------------------
// What is owed must match what the contract would actually pay.

test("a winner fee paid on a market that resolved decisively is not claimable", async () => {
  // claimInvalidWinnerFeeRefund reverts InvalidState unless finalOutcome is
  // Invalid, and winnerFeePaid is only ever zeroed by that same call — so on
  // every decisive outcome the balance is permanently non-zero and permanently
  // unclaimable. Reporting it as claimable shows every fee-paying trader money
  // that does not exist, forever, winner and loser alike.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, winner_reward_bps: 100, block_number: 40,
  });
  store.appendTrade({
    market_address: WON, account: ME, outcome_a: false, is_buy: true,
    amount_in: 100_000_000n, amount_out: 180_000_000n, block_number: 41,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "redeem", amount: 0n, block_number: 42 });

  const paidTheFee = {
    async readAccountState() {
      return { lpFeeCredit: 0n, winnerFeePaid: 1_000_000n };
    },
  };
  const view = await new Portfolio({ store, accountReader: paidTheFee }).of(ME);
  const row = view.predictions.settled.find((r) => r.market === WON.toLowerCase());

  assert.equal(row.claimable, false, "the refund call would revert on a decisive outcome");
  assert.equal(row.owed.winner_fee_refund, 0n, "so nothing is owed under that heading");
  assert.equal(view.predictions.claimable_count, 0);
});

test("a losing position is still described as lost when the market charged a fee", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, winner_reward_bps: 100, block_number: 40,
  });
  store.adjustHolding(WON, ME, { position_b: 180_000_000n }, 41);

  const paidTheFee = {
    async readAccountState() {
      return { lpFeeCredit: 0n, winnerFeePaid: 1_000_000n };
    },
  };
  const row = (await new Portfolio({ store, accountReader: paidTheFee }).of(ME)).predictions.settled[0];

  // A stale winnerFeePaid balance must not suppress the honest copy.
  assert.equal(row.claimable, false);
  assert.match(row.detail, /did not win/i);
});

test("LP fees include what claiming would accrue, not just the stored credit", async () => {
  // claimLpFees calls _accrueLp FIRST, moving (shares * feePerShare / SCALE -
  // debt) into the credit before paying it. Reading only the stored credit
  // reports 0 while the call would pay real collateral.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 40,
  });
  store.adjustHolding(WON, ME, { lp_shares: 1_000_000n }, 41);

  const FEE_SCALE = 10n ** 18n;
  const accruing = {
    async readAccountState() {
      return {
        lpFeeCredit: 0n,
        winnerFeePaid: 0n,
        lpShares: 1_000_000n,
        lpFeeDebt: 0n,
        feePerShare: (500_000n * FEE_SCALE) / 1_000_000n,
      };
    },
  };
  const row = (await new Portfolio({ store, accountReader: accruing }).of(ME)).predictions.settled[0];

  assert.equal(row.claimable, true);
  assert.equal(row.owed.lp_fees, 500_000n, "the accrual is part of what claiming pays");
});

test("an address the chain reader rejects degrades that market, not the whole portfolio", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 1, block_number: 40,
  });
  store.appendClaim({ market_address: WON, account: ME, kind: "redeem", amount: 5n, block_number: 41 });

  // viem throws on a mixed-case address that is not valid EIP-55. The reader is
  // given the address as the store holds it, so a caller's casing cannot decide
  // whether anyone's balances can be read.
  const strict = {
    async readAccountState(_market, account) {
      if (account !== String(account).toLowerCase()) throw new Error("invalid EIP-55 checksum");
      return { lpFeeCredit: 0n, winnerFeePaid: 0n };
    },
  };
  const view = await new Portfolio({ store, accountReader: strict }).of("0xF0ReCaStEr");
  assert.equal(view.predictions.settled[0].claimable, false, "a normalised address reads cleanly");
});

test("settled copy does not assert claims that were never made", async () => {
  const reader = { async readAccountState() { return { lpFeeCredit: 0n, winnerFeePaid: 0n }; } };

  // An Invalid market where this account traded but claimed nothing: the copy
  // must not say collateral "was returned" when the row's own claimed total is
  // zero. Contradicting itself in one line is worse than saying less.
  const invalid = new ProjectionStore();
  invalid.upsertMarket({
    market_address: VOID, room_id: "room-1", slot_index: 3,
    question: "Q", final_outcome: 4, winner_reward_bps: 0, block_number: 30,
  });
  invalid.appendTrade({
    market_address: VOID, account: ME, outcome_a: true, is_buy: true,
    amount_in: 10n, amount_out: 20n, block_number: 31,
  });
  const invalidRow = (await new Portfolio({ store: invalid, accountReader: reader }).of(ME)).predictions.settled[0];
  assert.equal(invalidRow.claimed, 0n);
  assert.ok(
    !/was returned|was refunded/.test(invalidRow.detail),
    `nothing was claimed here, so nothing was returned: ${invalidRow.detail}`
  );

  // A tie where this account claimed nothing: "both sides redeemed at 0.5"
  // describes a redemption that did not happen.
  const tie = new ProjectionStore();
  tie.upsertMarket({
    market_address: WON, room_id: "room-1", slot_index: 2,
    question: "Q", final_outcome: 3, block_number: 20,
  });
  tie.appendTrade({
    market_address: WON, account: ME, outcome_a: true, is_buy: true,
    amount_in: 10n, amount_out: 20n, block_number: 21,
  });
  const tieRow = (await new Portfolio({ store: tie, accountReader: reader }).of(ME)).predictions.settled[0];
  assert.equal(tieRow.claimed, 0n);
  assert.ok(
    !/both sides redeemed/.test(tieRow.detail),
    `no redemption was made here: ${tieRow.detail}`
  );
});
