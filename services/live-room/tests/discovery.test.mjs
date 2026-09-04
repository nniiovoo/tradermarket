// P0 Market Activity + P1 schedule, leaderboard and history.
//
// Every number these surfaces show must be derived from indexed chain facts.
// With no data they return empty and say so; they never invent participants,
// volume, payouts, or wins. That is the whole point of the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityFeed } from "../src/discovery/activity.mjs";
import { Schedule } from "../src/discovery/schedule.mjs";
import { Leaderboard } from "../src/discovery/leaderboard.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";

const ROOM = "room-1";
const HEADLINE = "0xm0";
const MICRO = "0xm1";
const ALICE = "0xalice";
const BOB = "0xbob";

function emptyStore() {
  return new ProjectionStore();
}

/** A store with one settled room, populated the way the indexer would. */
function settledStore() {
  const store = new ProjectionStore();
  store.upsertRoom({
    room_id: ROOM,
    live_room_address: "0xroom",
    state: "final",
    closed_source_seq: 50n,
    closed_at: "2026-08-19T03:07:00.000Z",
    block_number: 20,
  });
  store.upsertSlot({
    room_id: ROOM,
    slot_index: 0,
    state: "final",
    question: "Who wins the entire competition?",
    market_address: HEADLINE,
    condition_hash: "0xc0",
    opens_at: 1700000030n,
    closed_seq: 50n,
    winner_reward_bps: 100,
    block_number: 18,
  });
  store.upsertSlot({
    room_id: ROOM,
    slot_index: 1,
    state: "invalid",
    question: "Will Bob's return exceed 2%?",
    market_address: MICRO,
    condition_hash: "0xc1",
    closed_seq: 40n,
    winner_reward_bps: 0,
    block_number: 19,
  });
  store.upsertMarket({
    market_address: HEADLINE,
    room_id: ROOM,
    slot_index: 0,
    final_outcome: 1,
    finalized_block_number: 18,
    participant_a_name: "Alice",
    participant_b_name: "Bob",
    block_number: 18,
  });
  store.upsertMarket({
    market_address: MICRO,
    room_id: ROOM,
    slot_index: 1,
    final_outcome: 4,
    finalized_block_number: 19,
    participant_a_name: "Alice",
    participant_b_name: "Bob",
    block_number: 19,
  });
  store.appendClaim({ market_address: HEADLINE, account: ALICE, kind: "redeem", amount: 190n, block_number: 21 });
  store.appendClaim({ market_address: HEADLINE, account: BOB, kind: "lp_inventory", amount: 810n, block_number: 21 });
  store.appendClaim({ market_address: MICRO, account: ALICE, kind: "winner_fee_refund", amount: 5n, block_number: 22 });
  store.appendTrade({
    market_address: HEADLINE,
    account: ALICE,
    outcome_a: true,
    is_buy: true,
    amount_in: 100n,
    amount_out: 90n,
    block_number: 10,
  });
  store.cursorBlock = 22;
  return store;
}

// ------------------------------------------------------------- activity

test("an empty deployment shows no activity and says why", () => {
  const feed = new ActivityFeed({ store: emptyStore() });
  const result = feed.recentResolutions();
  assert.deepEqual(result.items, []);
  assert.match(result.empty_reason, /no settled market/i);
  assert.deepEqual(feed.recentCredits().items, [], "no invented wins");
});

test("recent resolutions come from settled slots, with their real outcome", () => {
  const feed = new ActivityFeed({ store: settledStore() });
  const { items } = feed.recentResolutions();
  assert.equal(items.length, 2);
  const headline = items.find((item) => item.market === HEADLINE);
  assert.equal(headline.question, "Who wins the entire competition?");
  assert.equal(headline.state, "final");
  assert.equal(headline.outcome_label, "outcome_a");
  assert.deepEqual(headline.participants, { a: "Alice", b: "Bob" });
  assert.equal(headline.winner_name, "Alice");
  const micro = items.find((item) => item.market === MICRO);
  assert.equal(micro.state, "invalid");
  assert.equal(micro.outcome_label, "invalid");
  assert.deepEqual(micro.payout_vector, { a: "0.5", b: "0.5" }, "invalid markets split");
});

test("recent credits are real claims, labelled by kind, never aggregated into fake wins", () => {
  const feed = new ActivityFeed({ store: settledStore() });
  const { items } = feed.recentCredits();
  assert.equal(items.length, 3);
  const kinds = items.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ["lp_inventory", "redeem", "winner_fee_refund"]);
  for (const item of items) {
    assert.ok(item.account, "every credit names the account that received it");
    assert.equal(typeof item.amount, "string");
    assert.ok(item.block_number > 0, "and the block that proves it");
  }
});

test("a market timeline carries opened, closed, final and claimable moments", () => {
  const feed = new ActivityFeed({ store: settledStore() });
  const timeline = feed.timeline(HEADLINE);
  const stages = timeline.map((entry) => entry.stage);
  assert.deepEqual(stages, ["opened", "closed", "final", "credited"]);
  assert.ok(timeline.every((entry) => entry.at !== undefined), "each stage says when, or that it is unknown");
  const credited = timeline.find((entry) => entry.stage === "credited");
  assert.equal(credited.reached, true, "claims prove crediting happened");
});

test("the final timeline moment uses the ResultFinalized block, never a later market refresh", () => {
  const store = settledStore();
  // A read refresh after a claim advances the market row's general freshness
  // block. It is not evidence that finalization happened there.
  store.upsertMarket({ market_address: HEADLINE, block_number: 30 });

  const timeline = new ActivityFeed({ store }).timeline(HEADLINE);
  assert.equal(timeline.find((entry) => entry.stage === "final").at, "block 18");
  assert.equal(timeline.find((entry) => entry.stage === "credited").at, "block 21");
});

test("a reached result with no indexed finalization block says when is unknown", () => {
  const store = new ProjectionStore();
  store.upsertMarket({ market_address: HEADLINE, final_outcome: 1, block_number: 30 });

  const final = new ActivityFeed({ store }).timeline(HEADLINE).find((entry) => entry.stage === "final");
  assert.equal(final.reached, true);
  assert.equal(final.at, null, "the latest refresh block must not be relabelled as finalization");
});

test("an unclaimed market's timeline shows credited as not yet reached", () => {
  const store = settledStore();
  store.claims = store.claims.filter((claim) => claim.market_address !== MICRO);
  const timeline = new ActivityFeed({ store }).timeline(MICRO);
  assert.equal(timeline.find((entry) => entry.stage === "credited").reached, false);
  assert.equal(timeline.find((entry) => entry.stage === "final").reached, true);
});

// ------------------------------------------------------------- schedule

test("the schedule is empty when no room exists, and never invents one", () => {
  const schedule = new Schedule({ store: emptyStore() });
  const result = schedule.list();
  assert.deepEqual(result.live, []);
  assert.deepEqual(result.upcoming, []);
  assert.deepEqual(result.recent, []);
  assert.match(result.empty_reason, /no room/i);
});

test("rooms are grouped by their real state", () => {
  const store = settledStore();
  store.upsertRoom({ room_id: "room-live", state: "live", live_room_address: "0xr2", block_number: 5 });
  store.upsertRoom({ room_id: "room-armed", state: "armed", live_room_address: "0xr3", block_number: 6 });
  const result = new Schedule({ store }).list();
  assert.deepEqual(result.live.map((entry) => entry.room_id), ["room-live"]);
  assert.deepEqual(result.upcoming.map((entry) => entry.room_id), ["room-armed"]);
  assert.deepEqual(result.recent.map((entry) => entry.room_id), [ROOM]);
});

test("schedule entries carry a stable shareable route", () => {
  const store = settledStore();
  store.upsertRoom({ room_id: "room-live", state: "live", live_room_address: "0xr2", block_number: 5 });
  const [entry] = new Schedule({ store }).list().live;
  assert.equal(entry.route, "/room/room-live");
  assert.equal(typeof entry.open_slots, "number");
});

// ---------------------------------------------------------- leaderboard

test("the leaderboard is empty until real settlements exist", () => {
  const board = new Leaderboard({ store: emptyStore() });
  const result = board.top();
  assert.deepEqual(result.entries, []);
  assert.match(result.empty_reason, /no settled/i);
  assert.equal(result.derived_from, "indexed chain claims");
});

test("rankings are derived from indexed claims, not invented", () => {
  const board = new Leaderboard({ store: settledStore() });
  const { entries } = board.top();
  assert.equal(entries.length, 2);
  const bob = entries.find((entry) => entry.account === BOB);
  const alice = entries.find((entry) => entry.account === ALICE);
  assert.equal(bob.credited, "810");
  assert.equal(alice.credited, "195", "190 redeemed plus a 5 refund");
  assert.equal(entries[0].account, BOB, "ranked by credited amount");
  assert.equal(entries[0].rank, 1);
});

test("the leaderboard reports what it counts, and counts no XP it cannot prove", () => {
  const board = new Leaderboard({ store: settledStore() });
  const result = board.top();
  assert.match(result.basis, /credited/i);
  for (const entry of result.entries) {
    assert.ok(!("xp" in entry), "no XP is fabricated");
    assert.ok(!("win_rate" in entry) || entry.win_rate !== null, "a win rate is only present when derivable");
    assert.ok(entry.settled_markets >= 1, "every entry is backed by settled markets");
  }
});

test("an account profile summarises only its own indexed facts", () => {
  const board = new Leaderboard({ store: settledStore() });
  const profile = board.profile(ALICE);
  assert.equal(profile.account, ALICE);
  assert.equal(profile.credited, "195");
  assert.equal(profile.trades, 1);
  assert.equal(profile.settled_markets, 2);
  assert.equal(new Leaderboard({ store: emptyStore() }).profile(ALICE).credited, "0");
});

test("a timeline is found by the same address the activity list links to", () => {
  // `claim.market_address` is `log.address` — lowercase, as eth_getLogs returns
  // it. `slot.market_address` is `log.args.market` — checksummed, as viem
  // decodes an address parameter. The Activity list builds its route from the
  // checksummed form, so a raw `===` made the detail page reached from that list
  // report "credited: not reached" for a market that had paid out, right beside
  // a claims list that found them.
  const CHECKSUM = "0xAbC0000000000000000000000000000000000001";
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: CHECKSUM, room_id: "r", slot_index: 0,
    question: "Q", final_outcome: 1, block_number: 10,
  });
  store.appendClaim({
    market_address: CHECKSUM.toLowerCase(), account: "0xU",
    kind: "redeem", amount: 5n, block_number: 11,
  });

  const feed = new ActivityFeed({ store });
  for (const form of [CHECKSUM, CHECKSUM.toLowerCase(), CHECKSUM.toUpperCase()]) {
    const credited = feed.timeline(form).find((stage) => stage.stage === "credited");
    assert.equal(credited.reached, true, `credited must be found for ${form}`);
  }
});

test("a market that never settled is not counted as a settled market", () => {
  const store = new ProjectionStore();
  store.upsertMarket({ market_address: "0xOPEN", room_id: "r", slot_index: 0, final_outcome: 0, block_number: 5 });
  store.upsertMarket({ market_address: "0xDONE", room_id: "r", slot_index: 1, final_outcome: 1, block_number: 6 });
  store.appendTrade({
    market_address: "0xOPEN", account: "0xA", outcome_a: true, is_buy: true,
    amount_in: 5n, amount_out: 9n, block_number: 7,
  });
  store.appendClaim({ market_address: "0xDONE", account: "0xA", kind: "redeem", amount: 9n, block_number: 8 });

  // The count was every market the account touched, so an open position was
  // reported as a settled market on the leaderboard and the profile.
  const profile = new Leaderboard({ store }).profile("0xA");
  assert.equal(profile.settled_markets, 1, "only the market that actually resolved");

  const top = new Leaderboard({ store }).top();
  assert.equal(top.entries[0].settled_markets, 1);
});

test("the schedule lists only rooms this process can actually serve", () => {
  const store = new ProjectionStore();
  store.upsertRoom({ room_id: "served", live_room_address: "0xr1", state: "live", block_number: 5 });
  // A room discovered from the factory that this process does not index: its
  // slots are never read, so listing it means fabricated zero counts and a
  // route that 404s on the room API.
  store.upsertRoom({ room_id: "elsewhere", live_room_address: "0xr2", state: "live", block_number: 6 });

  const listed = new Schedule({ store, roomId: "served" }).list();
  const ids = [...listed.live, ...listed.upcoming, ...listed.recent].map((entry) => entry.room_id);
  assert.deepEqual(ids, ["served"], "a room this process cannot serve must not be offered as a link");
});
