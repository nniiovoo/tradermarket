// P2 growth surfaces, and the account-choice question the entry flow has to
// answer honestly.
//
// Referrals and social proof are the easiest places in a product to invent
// numbers, so the rule here is strict: with nothing configured, these surfaces
// report that they are off and return no figures at all. A referral programme
// that cannot attribute a referral must not offer one, and a community surface
// must never manufacture a member count, a testimonial, or a winner callout.

import test from "node:test";
import assert from "node:assert/strict";

import { Capabilities } from "../src/config/capabilities.mjs";
import { Growth } from "../src/growth/growth.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";

const off = () => new Capabilities({ room: { apiUrl: "http://x" } });
const on = () =>
  new Capabilities({
    room: { apiUrl: "http://x" },
    referrals: { enabled: true, programId: "testnet-referral-1" },
    socialProof: { enabled: true },
    community: { inviteUrl: "https://example.invalid/community" },
  });

test("referrals are off by default and offer nothing", async () => {
  const growth = new Growth({ capabilities: off(), store: new ProjectionStore() });
  const view = await growth.referrals("0xME");

  assert.equal(view.available, false);
  assert.match(view.reason, /referral/i);
  assert.equal(view.code, null, "an unconfigured programme must not mint a code");
  assert.equal(view.referred, 0);
  assert.equal(view.earned, "0");
  assert.ok(!("reward" in view), "no reward may be advertised where none is funded");
});

test("a configured referral programme issues a deterministic code and no promised reward", async () => {
  const growth = new Growth({ capabilities: on(), store: new ProjectionStore() });
  const first = await growth.referrals("0xME");
  const again = await growth.referrals("0xme");

  assert.equal(first.available, true);
  assert.ok(first.code && first.code.length >= 6);
  assert.equal(first.code, again.code, "the same address always gets the same code");
  assert.equal(first.program_id, "testnet-referral-1");
  assert.match(first.notice, /no real-world value|test/i);
  assert.equal(first.referred, 0, "attribution starts at zero, not at an invented number");
});

test("social proof reports only what the chain recorded", () => {
  const store = new ProjectionStore();
  const growth = new Growth({ capabilities: on(), store });

  const empty = growth.socialProof();
  assert.equal(empty.available, true);
  assert.deepEqual(empty.recent_wins, []);
  assert.equal(empty.participants, 0);
  assert.match(empty.empty_reason, /no .*(settled|credited|claim)/i);

  store.upsertMarket({ market_address: "0xM", room_id: "r", slot_index: 0, question: "Q?", final_outcome: 1, block_number: 3 });
  store.appendClaim({ market_address: "0xM", account: "0xA", kind: "redeem", amount: 5_000_000n, block_number: 4 });

  const filled = growth.socialProof();
  assert.equal(filled.participants, 1);
  assert.equal(filled.recent_wins.length, 1);
  assert.equal(filled.recent_wins[0].amount, 5_000_000n);
  assert.equal(filled.recent_wins[0].account, "0xa");
  assert.equal(filled.empty_reason, null);
});

test("social proof stays silent when it is not configured", () => {
  const store = new ProjectionStore();
  store.appendClaim({ market_address: "0xM", account: "0xA", kind: "redeem", amount: 5_000_000n, block_number: 4 });
  const view = new Growth({ capabilities: off(), store }).socialProof();

  assert.equal(view.available, false);
  assert.deepEqual(view.recent_wins, [], "an unconfigured surface publishes nobody's activity");
  assert.equal(view.participants, 0);
});

test("account choice names only the account types this deployment actually supports", () => {
  const view = new Growth({ capabilities: off(), store: new ProjectionStore() }).accountOptions();

  const injected = view.options.find((option) => option.id === "injected_wallet");
  assert.equal(injected.available, true);
  assert.match(injected.detail, /your keys|custody/i);

  const embedded = view.options.find((option) => option.id === "embedded_account");
  assert.equal(embedded.available, false, "no embedded-account provider is configured");
  assert.match(embedded.reason, /provider|not configured/i);
  assert.match(view.custody_note, /never (holds|takes)/i);
});

test("a zero-value redemption is not a win", () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: "0xM", room_id: "r", slot_index: 0,
    question: "Q?", final_outcome: 1, block_number: 3,
  });
  // redeemPositions reverts only when *both* sides are zero, so a holder of the
  // losing side can redeem for a payout of 0. Listing that under "Recently
  // credited" displays a loss as a win.
  store.appendClaim({ market_address: "0xM", account: "0xLOSER", kind: "redeem", amount: 0n, block_number: 4 });

  const view = new Growth({ capabilities: on(), store }).socialProof();
  assert.deepEqual(view.recent_wins, []);
  assert.equal(view.participants, 0, "nobody was credited");

  store.appendClaim({ market_address: "0xM", account: "0xWINNER", kind: "redeem", amount: 5_000_000n, block_number: 5 });
  const after = new Growth({ capabilities: on(), store }).socialProof();
  assert.equal(after.recent_wins.length, 1);
  assert.equal(after.recent_wins[0].account, "0xwinner");
  assert.equal(after.participants, 1);
});
