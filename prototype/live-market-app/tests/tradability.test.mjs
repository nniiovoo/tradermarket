// Which markets may be traded.
//
// This is the highest-consequence rendering decision in the app: offering a buy
// button on a market that cannot accept one takes someone's intent and produces
// nothing, and on a settled market it invites them to back a result that is
// already known.
//
// The rule is that trading is allowed only for a slot the chain reports as
// open. Everything else — announced, awaiting liquidity, suspended, closed,
// recovering, provisional, challenged, final, invalid — is not tradable, and
// the default for an unrecognised state must be "no".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { marketAcceptsLiquidity, marketCardPresentation, marketIsTradable, marketSectionTitle } = await import("../src/market-state.js");

const ALL_SLOT_STATES = [
  "announced",
  "awaiting-liquidity",
  "open",
  "suspended",
  "closed",
  "recovering",
  "provisional",
  "challenged",
  "final",
  "invalid",
];

test("only an open slot is tradable", () => {
  for (const state of ALL_SLOT_STATES) {
    const tradable = marketIsTradable({ state });
    assert.equal(tradable, state === "open", `slot state "${state}" tradable should be ${state === "open"}`);
  }
});

test("an unknown or missing state is not tradable", () => {
  assert.equal(marketIsTradable({ state: "something-new" }), false, "a new chain state must fail closed");
  assert.equal(marketIsTradable({}), false);
  assert.equal(marketIsTradable(null), false);
});

test("a resolved outcome closes trading whatever the slot state says", () => {
  assert.equal(marketIsTradable({ state: "open", finalOutcome: 1 }), false);
  assert.equal(marketIsTradable({ state: "open", finalOutcome: 4 }), false);
  assert.equal(marketIsTradable({ state: "open", finalOutcome: 0 }), true);
});

test("a standalone market with no slot state falls back to its gate state", () => {
  // The single-market path has no room slot; it reports a gate state instead.
  assert.equal(marketIsTradable({ gateState: 0, finalOutcome: 0 }), true, "gate open");
  assert.equal(marketIsTradable({ gateState: 1, finalOutcome: 0 }), false, "gate suspended");
  assert.equal(marketIsTradable({ gateState: 2, finalOutcome: 0 }), false, "forecasting closed");
});

test("settled cards never invite a person to watch and predict", () => {
  assert.deepEqual(marketCardPresentation({ state: "final" }), {
    category: "Final result",
    action: "View settlement",
  });
  assert.deepEqual(marketCardPresentation({ state: "invalid" }), {
    category: "Invalid market",
    action: "View refund record",
  });
});

test("open and upcoming cards describe what a person can actually do", () => {
  assert.deepEqual(marketCardPresentation({ state: "open" }), {
    category: "Live question",
    action: "Watch & predict",
  });
  assert.deepEqual(marketCardPresentation({ state: "announced" }), {
    category: "Upcoming question",
    action: "View question",
  });
});

test("the room-card section title follows the cards it actually contains", () => {
  assert.equal(marketSectionTitle([{ state: "open" }, { state: "final" }]), "Happening now");
  assert.equal(marketSectionTitle([{ state: "final" }, { state: "invalid" }]), "Recently settled");
  assert.equal(marketSectionTitle([{ state: "announced" }]), "Upcoming questions");
  assert.equal(marketSectionTitle([]), "Live questions");
});

test("liquidity is offered only before or during an open question", () => {
  assert.equal(marketAcceptsLiquidity({ state: "awaiting-liquidity" }), true);
  assert.equal(marketAcceptsLiquidity({ state: "open" }), true);
  for (const state of ["announced", "suspended", "closed", "provisional", "challenged", "final", "invalid"]) {
    assert.equal(marketAcceptsLiquidity({ state }), false, `${state} must not offer a deposit`);
  }
  assert.equal(marketAcceptsLiquidity({ gateState: 0, finalOutcome: 0 }), true, "standalone open market");
  assert.equal(marketAcceptsLiquidity({ gateState: 2, finalOutcome: 0 }), false, "standalone closed market");
});

test("the shipped Home UI consumes the state-aware card, section and liquidity rules", () => {
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /marketCardPresentation\(market\)/);
  assert.match(app, /marketSectionTitle\(room\?\.roomCards/);
  assert.match(app, /marketAcceptsLiquidity\(market\)/);
});
