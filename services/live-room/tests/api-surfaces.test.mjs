// The HTTP surfaces the website needs (P0 + P1), served from real data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomApiServer } from "../src/api/server.mjs";
import { Allowlist } from "../src/api/allowlist.mjs";
import { Capabilities } from "../src/config/capabilities.mjs";
import { EntryGate, TERMS_VERSION, ELIGIBILITY_ATTESTATIONS } from "../src/entry/entry.mjs";
import { HelpCenter } from "../src/help/help.mjs";
import { ActivityFeed } from "../src/discovery/activity.mjs";
import { Schedule } from "../src/discovery/schedule.mjs";
import { Leaderboard } from "../src/discovery/leaderboard.mjs";
import { Portfolio } from "../src/discovery/portfolio.mjs";
import { RealtimeEdge, ChatService, PlaybackService } from "../src/edge/edge.mjs";
import { LiveRoomCoordinator } from "../src/coordinator/coordinator.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { MemoryEventStore } from "../src/ports/stores.mjs";

const ROOM_ID = "room-1";
const MARKET = "0xm0";

function store() {
  const projection = new ProjectionStore();
  projection.upsertRoom({ room_id: ROOM_ID, live_room_address: "0xroom", state: "final", closed_source_seq: 9n, block_number: 5 });
  projection.upsertSlot({
    room_id: ROOM_ID, slot_index: 0, state: "final", question: "Who wins?",
    market_address: MARKET, condition_hash: "0xc0", winner_reward_bps: 100, block_number: 5,
  });
  projection.upsertMarket({ market_address: MARKET, room_id: ROOM_ID, slot_index: 0, final_outcome: 1, block_number: 5 });
  projection.appendClaim({ market_address: MARKET, account: "0xalice", kind: "redeem", amount: 190n, block_number: 6 });
  projection.cursorBlock = 6;
  return projection;
}

async function harness({ capabilities = new Capabilities({}), allowlistEnabled = false } = {}) {
  const projection = store();
  const eventLog = new MemoryEventStore();
  const edgeRef = {};
  const coordinator = new LiveRoomCoordinator({
    roomId: ROOM_ID, store: projection, eventLog,
    publishTo: (frame) => edgeRef.edge?.broadcast(frame),
    config: { freshnessThresholdMs: 20000, retention: 20, heartbeatMs: 10000 },
  });
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10000, maxQueue: 16 } });
  edgeRef.edge = edge;
  const allowlist = new Allowlist({ addresses: ["0xallowed"], enabled: allowlistEnabled });
  const server = new RoomApiServer({
    coordinator, edge, store: projection, eventLog,
    chat: new ChatService({ verifySignature: async () => true, config: { rateLimitPerMinute: 5, moderators: new Set() } }),
    playback: new PlaybackService({ config: {} }),
    allowlist: allowlistEnabled ? allowlist : null,
    capabilities,
    entry: new EntryGate({
      allowlist,
      capabilities,
      verifySignature: async (_address, _message, signature) => signature === "0xGOOD",
    }),
    help: new HelpCenter(),
    activity: new ActivityFeed({ store: projection }),
    schedule: new Schedule({ store: projection }),
    leaderboard: new Leaderboard({ store: projection }),
    // Mirrors production, which wires the chain reader: without one the
    // per-account balances are unknown rather than zero.
    portfolio: new Portfolio({
      store: projection,
      accountReader: { async readAccountState() { return { lpFeeCredit: 0n, winnerFeePaid: 0n }; } },
    }),
  });
  const address = await server.listen(0);
  coordinator.tick();
  return { server, base: `http://127.0.0.1:${address.port}`, projection };
}

const get = async (base, path, headers = {}) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
};

test("/v1/capabilities tells the website what actually exists", async () => {
  const { server, base } = await harness();
  try {
    const { body } = await get(base, "/v1/capabilities");
    // No chain configured in this harness, so the testnet claim is unknown
    // rather than asserted. A configured chain is covered in capabilities.test.
    assert.equal(body.testnet, null);
    assert.equal(body.capabilities.gas_sponsorship.available, false);
    assert.equal(body.capabilities.legal_availability.available, false);
    assert.match(body.gas_statement, /pay your own gas/i);
    assert.match(body.collateral_notice, /not known/i);
  } finally {
    await server.close();
  }
});

test("/v1/activity serves real resolutions, credits and a timeline", async () => {
  const { server, base } = await harness();
  try {
    const feed = await get(base, "/v1/activity");
    assert.equal(feed.body.resolutions.items.length, 1);
    assert.equal(feed.body.credits.items.length, 1);

    const detail = await get(base, `/v1/activity/${MARKET}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.timeline.length, 4);
    assert.equal(detail.body.timeline.at(-1).stage, "credited");
    assert.equal(detail.body.timeline.at(-1).reached, true);
  } finally {
    await server.close();
  }
});

test("/v1/schedule, /v1/leaderboard and /v1/profile serve derived data", async () => {
  const { server, base } = await harness();
  try {
    const schedule = await get(base, "/v1/schedule");
    assert.equal(schedule.body.recent.length, 1);
    assert.equal(schedule.body.recent[0].route, `/room/${ROOM_ID}`);

    const board = await get(base, "/v1/leaderboard");
    assert.equal(board.body.entries.length, 1);
    assert.equal(board.body.entries[0].credited, "190");
    assert.match(board.body.derived_from, /indexed/i);

    const profile = await get(base, "/v1/profiles/0xalice");
    assert.equal(profile.body.credited, "190");
  } finally {
    await server.close();
  }
});

test("/v1/help is browsable and searchable", async () => {
  const { server, base } = await harness();
  try {
    const index = await get(base, "/v1/help");
    assert.ok(index.body.categories.length >= 4);

    const article = await get(base, "/v1/help/what-is-an-invalid-market");
    assert.equal(article.status, 200);
    assert.match(article.body.body, /Invalid/);

    const search = await get(base, "/v1/help?q=integrity");
    assert.ok(search.body.results.length > 0);

    const missing = await get(base, "/v1/help/no-such-article");
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test("the entry journey is served and terms can be accepted", async () => {
  const { server, base } = await harness({ allowlistEnabled: true });
  try {
    const terms = await get(base, "/v1/entry/terms");
    assert.equal(terms.body.version, TERMS_VERSION);
    assert.equal(terms.body.attestations.length, ELIGIBILITY_ATTESTATIONS.length);

    const before = await get(base, "/v1/entry/status?address=0xallowed");
    assert.equal(before.body.can_enter, false);

    const partial = await fetch(`${base}/v1/entry/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "0xallowed", version: TERMS_VERSION, attestations: { age: true } }),
    });
    assert.equal(partial.status, 400);

    const accept = await fetch(`${base}/v1/entry/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "0xallowed",
        version: TERMS_VERSION,
        attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true])),
      }),
    });
    assert.equal(accept.status, 200);
    assert.equal(accept.body?.proven ?? (await accept.json()).proven, false);

    // Unsigned, so the journey step is recorded but the gate is not opened:
    // allowlisted addresses are public and anyone could post this.
    const unsigned = await get(base, "/v1/entry/status?address=0xallowed");
    assert.equal(unsigned.body.can_enter, false);

    const signed = await fetch(`${base}/v1/entry/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: "0xallowed",
        version: TERMS_VERSION,
        attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true])),
        claim: ["tradermarket-terms-v1", "0xallowed", TERMS_VERSION].join("\n"),
        signature: "0xGOOD",
      }),
    });
    assert.equal(signed.status, 200);

    const after = await get(base, "/v1/entry/status?address=0xallowed");
    assert.equal(after.body.can_enter, true);
  } finally {
    await server.close();
  }
});

test("entry, capabilities and help stay reachable behind the allowlist", async () => {
  // A person who cannot enter must still be able to read why, and read the
  // help and legal pages that explain it.
  const { server, base } = await harness({ allowlistEnabled: true });
  try {
    for (const path of ["/v1/capabilities", "/v1/entry/terms", "/v1/entry/status", "/v1/help", "/v1/health"]) {
      const response = await get(base, path);
      assert.equal(response.status, 200, `${path} must be reachable without an allowlisted address`);
    }
    const gated = await get(base, `/v1/rooms/${ROOM_ID}`);
    assert.equal(gated.status, 403, "the room itself stays gated");
  } finally {
    await server.close();
  }
});

test("/v1/portfolio serves one address's own history from indexed facts", async () => {
  const { server, base } = await harness();
  try {
    const { status, body } = await get(base, "/v1/portfolio/0xalice");
    assert.equal(status, 200);
    assert.equal(body.account, "0xalice");
    assert.equal(body.payouts.total_credited, "190", "amounts serialize as strings, never as floats");
    assert.equal(body.transactions.length, 1);
    assert.equal(body.transactions[0].type, "claim");
    assert.equal(body.transactions[0].summary, "Winning position redeemed");

    const settled = body.predictions.settled.find((row) => row.market === MARKET);
    assert.equal(settled.outcome_label, "outcome_a");
    assert.equal(settled.claimable, false);
  } finally {
    await server.close();
  }
});

test("/v1/portfolio for an unknown address explains itself instead of erroring", async () => {
  const { server, base } = await harness();
  try {
    const { status, body } = await get(base, "/v1/portfolio/0xnobody");
    assert.equal(status, 200);
    assert.deepEqual(body.transactions, []);
    assert.match(body.empty_reason, /no positions, trades or claims/i);
  } finally {
    await server.close();
  }
});
