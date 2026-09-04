// Issues 10 (server half), 11, and 17: the HTTP surface is read-and-social
// only, settlement records replay, and the allowlist is honest about being an
// interface control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RoomApiServer } from "../src/api/server.mjs";
import { Allowlist, DENIAL_COPY } from "../src/api/allowlist.mjs";
import { SettlementService } from "../src/settlement/settlement.mjs";
import { RealtimeEdge, ChatService, PlaybackService } from "../src/edge/edge.mjs";
import { LiveRoomCoordinator } from "../src/coordinator/coordinator.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { ChainIndexer, GATE_STATE } from "../src/indexer/indexer.mjs";
import { MemoryEventStore, MemoryRawArchive } from "../src/ports/stores.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { normalizeFillsResponse, normalizeBaseline } from "../src/connector/hyperliquid.mjs";

const FACTORY = "0xFACTORY";
const ROOM = "0xROOM";
const HEADLINE = "0xM0";
const ROOM_ID = "room-1";
const connectorAccount = privateKeyToAccount(generatePrivateKey());

const HEADLINE_CONDITION = {
  condition_version: "1.0.0",
  template: "first_to_realized_pnl",
  params: { target: "1000" },
};

class FakeLogSource {
  constructor(logs) {
    this.logs = logs;
  }

  async getLogs({ fromBlock, toBlock }) {
    return this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
  }
}

function logs() {
  return [
    {
      blockNumber: 1,
      logIndex: 0,
      address: FACTORY,
      event: "RoomCreated",
      args: { room: ROOM, roomId: ROOM_ID, publisher: "0xPUB", gateSigner: "0xGATE" },
    },
    {
      blockNumber: 2,
      logIndex: 1,
      address: FACTORY,
      event: "MarketCreated",
      args: {
        market: HEADLINE,
        participantA: "0xPA",
        participantB: "0xPB",
        roomId: ROOM_ID,
        slotIndex: 0,
        templateId: "tpl-participant-v1",
        conditionHash: "0xC0",
        question: "Who wins?",
        streamUrl: "",
      },
    },
    {
      blockNumber: 2,
      logIndex: 2,
      address: ROOM,
      event: "SlotPublished",
      args: {
        market: HEADLINE,
        slotIndex: 0,
        templateId: "tpl-participant-v1",
        requestHash: "0xR0",
        conditionHash: "0xC0",
        nonce: 1n,
        undecidedThroughSequence: 2n,
        opensAt: 30n,
      },
    },
    {
      blockNumber: 4,
      logIndex: 3,
      address: HEADLINE,
      event: "ActionSubmitted",
      args: { actionId: 0n, epoch: 1n, kind: 0, user: "0xTRADER", amount: 100n },
    },
    { blockNumber: 5, logIndex: 4, address: HEADLINE, event: "ActionExecuted", args: { actionId: 0n, epoch: 1n, returnAmount: 90n } },
    {
      blockNumber: 5,
      logIndex: 5,
      address: HEADLINE,
      event: "Trade",
      args: { user: "0xTRADER", participantAOutcome: true, isBuy: true, amountIn: 100n, amountOut: 90n },
    },
    { blockNumber: 6, logIndex: 6, address: ROOM, event: "RoomClosed", args: { decisiveSequence: 3n } },
    { blockNumber: 6, logIndex: 7, address: ROOM, event: "SlotsClosed", args: { decisiveSequence: 3n, closed: 1n } },
    { blockNumber: 6, logIndex: 8, address: HEADLINE, event: "ForecastingClosed", args: { epoch: 1n, decisiveSequence: 3n } },
    { blockNumber: 7, logIndex: 8, address: HEADLINE, event: "ResultFinalized", args: { outcome: 1 } },
  ];
}

async function harness({ allowlist = null } = {}) {
  const store = new ProjectionStore();
  const marketState = {
    participantAName: "Alice",
    participantBName: "Bob",
    gateState: GATE_STATE.closed,
    reserveA: 1000n,
    reserveB: 1000n,
    spotPriceA: 500000n,
    totalLpShares: 1000n,
    winnerRewardPool: 0n,
    pendingCollateral: 0n,
    collateralBacking: 1000n,
    unclaimedLpFees: 0n,
    currentEpoch: 1n,
    lastSafeSequence: 2n,
    finalOutcome: 1,
    provisionalAt: 0n,
  };
  const indexer = new ChainIndexer({
    store,
    logs: new FakeLogSource(logs()),
    reader: { async readMarketState() {
      return marketState;
    } },
  });
  await indexer.syncTo(7);

  const eventLog = new MemoryEventStore();
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store: eventLog,
    rawArchive: new MemoryRawArchive(),
    signer: connectorAccount,
    clock: () => new Date().toISOString(),
  });
  await connector.ingestBatch({
    rawBytes: JSON.stringify({ marginSummary: { accountValue: "10000" } }),
    rawQuery: { endpoint: "info", type: "clearinghouseState", user: "0xA", at: 1000 },
    drafts: [normalizeBaseline("alice", "0xA", { marginSummary: { accountValue: "10000" } }, 1000)],
  });
  const fills = [{ tid: 1, time: 4000, closedPnl: "1200", fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" }];
  await connector.ingestBatch({
    rawBytes: JSON.stringify(fills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: "0xA", startTime: 0, endTime: 5000 },
    drafts: normalizeFillsResponse("alice", "0xA", fills),
  });

  const edgeRef = {};
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog,
    publishTo: (frame) => edgeRef.edge?.broadcast(frame),
    config: { freshnessThresholdMs: 20_000, retention: 50, heartbeatMs: 10_000 },
  });
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 32 } });
  edgeRef.edge = edge;
  const chat = new ChatService({
    verifySignature: async (_a, _t, signature) => signature === "0xGOOD",
    config: { rateLimitPerMinute: 5, moderators: new Set(["0xMOD"]) },
  });
  const playback = new PlaybackService({ config: { degradedAfterMs: 5000, disclosedDelayS: 0 } });
  playback.observe({ ok: true, lastSegmentAgeMs: 0, nowMs: 0 });
  playback.mark(2, 4000);

  const settlement = new SettlementService({
    store,
    eventLog,
    conditions: new Map([[HEADLINE, HEADLINE_CONDITION]]),
    participantKeys: { a: "alice", b: "bob" },
    playback,
    chainRefs: new Map([
      [
        HEADLINE,
        {
          closeTx: "0xclose",
          finalizeTx: "0xfinal",
          attestations: [{ resolver: "0xR1", tx: "0xa1" }, { resolver: "0xR2", tx: "0xa2" }],
          claims: [{ account: "0xTRADER", tx: "0xclaim" }],
        },
      ],
    ]),
  });

  const server = new RoomApiServer({ coordinator, edge, chat, playback, store, eventLog, settlement, allowlist });
  const address = await server.listen(0);
  coordinator.tick();
  return { server, base: `http://127.0.0.1:${address.port}`, coordinator, store, settlement, chat, connector, eventLog };
}

async function get(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

test("there is no trading endpoint anywhere in the HTTP surface", () => {
  const source = readFileSync(new URL("../src/api/server.mjs", import.meta.url), "utf8");
  for (const forbidden of ["submitBuy", "submitSell", "/order", "/trade", "submitAddLiquidity", "sendTransaction"]) {
    assert.ok(!source.includes(forbidden), `the API must not expose ${forbidden}`);
  }
});

test("room, program, slot, and market reads work", async () => {
  const { server, base } = await harness();
  try {
    const rooms = await get(base, "/v1/rooms");
    assert.equal(rooms.body.rooms.length, 1);

    const room = await get(base, "/v1/rooms/room-1");
    assert.equal(room.status, 200);
    assert.equal(room.body.room, "room-1");
    assert.equal(room.body.program.slots.length, 1);

    const slot = await get(base, `/v1/rooms/${ROOM_ID}/slots/0`);
    assert.equal(slot.body.question, "Who wins?");
    assert.equal(slot.body.price.implied_prob_a, "500000");
    assert.ok(slot.body.price.block, "every price carries its block");

    const market = await get(base, `/v1/markets/${HEADLINE}`);
    assert.equal(market.body.market_address, HEADLINE);

    const unknown = await get(base, "/v1/rooms/nope");
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
  }
});

test("health reports three independent signals", async () => {
  const { server, base } = await harness();
  try {
    const health = await get(base, "/v1/health");
    assert.deepEqual(Object.keys(health.body).sort(), [
      "block",
      // Null unless the process can see that it is misconfigured — a room id
      // pointing at a different room than the configured contract.
      "config_warning",
      "indexer",
      // Whether this replica is indexing at all. A standby serves a
      // plausible-looking empty room rather than an error, so a load balancer
      // needs this to drain on. Null when the process was built without a
      // leadership source, as this harness is.
      "leading",
      // What the separate authority processes reported about themselves. Empty
      // here: this harness runs none, and an empty list is the honest answer —
      // "no authority has reported" is not "the authorities are fine".
      "operators",
      "room_seq",
      "source",
      "source_seq",
      "stream",
    ]);
    assert.equal(health.body.config_warning, null, "this harness is configured consistently");
    assert.equal(health.body.stream, "live");
    assert.deepEqual(health.body.operators, []);

    // The point of this test: stream, source and indexer stay three separate
    // answers. Merging them into one indicator would let a healthy livestream
    // vouch for a stale data source, which is the exact confusion this product
    // exists to refuse.
    assert.equal(typeof health.body.stream, "string");
    assert.equal(typeof health.body.source, "string");
    assert.equal(typeof health.body.indexer, "string");
    assert.notEqual(health.body.stream, health.body.source, "distinct signals, not one value copied three times");
  } finally {
    await server.close();
  }
});

test("the SSE stream delivers hello and live frames", async () => {
  const { server, base, coordinator } = await harness();
  try {
    const response = await fetch(`${base}/v1/rooms/room-1/stream`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /"type":"hello"/);

    coordinator.setViewers(42);
    const next = decoder.decode((await reader.read()).value);
    assert.match(next, /"type":"viewers.updated"/);
    assert.match(next, /"count":42/);
    await reader.cancel();
  } finally {
    await server.close();
  }
});

test("chat posts through the API and rejects unauthenticated writes", async () => {
  const { server, chat, base } = await harness();
  const claimFor = (text) => chat.claimFor({ roomId: "room-1", address: "0xA", text, issuedAt: Date.now() });
  try {
    const bad = await fetch(`${base}/v1/rooms/room-1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "0xA", text: "hi", claim: claimFor("hi"), signature: "0xBAD" }),
    });
    assert.equal(bad.status, 400);

    const good = await fetch(`${base}/v1/rooms/room-1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "0xA", text: "hello", claim: claimFor("hello"), signature: "0xGOOD" }),
    });
    assert.equal(good.status, 200);

    const history = await get(base, "/v1/rooms/room-1/chat");
    assert.equal(history.body.messages.length, 1);
    assert.match(history.body.pinned.text, /cannot change a result/);
  } finally {
    await server.close();
  }
});

test("the settlement record links evidence, quorum, payout, and chain", async () => {
  const { server, base } = await harness();
  try {
    const settlement = await get(base, `/v1/markets/${HEADLINE}/settlement`);
    const record = settlement.body;
    assert.equal(record.question, "Who wins?");
    assert.equal(record.evaluator_version, "1.0.0");
    assert.equal(record.decisive_event.outcome, "alice");
    assert.equal(record.resolution.quorum, true);
    assert.deepEqual(record.resolution.payout_vector, { a: "1", b: "0" });
    assert.deepEqual(record.participants, { a: "Alice", b: "Bob" });
    assert.equal(record.resolution.winner_name, "Alice");
    assert.equal(record.chain.finalized_block, 7);
    assert.equal(record.chain.finalize_tx, "0xfinal");
    assert.equal(record.chain.claims[0].tx, "0xclaim");
    assert.ok(record.deciding_events.length > 0, "the deciding events are shown with raw pointers");
    assert.ok(record.deciding_events[0].raw_query, "each deciding event carries its raw query");
    assert.equal(typeof record.replay.stream_offset_s, "number", "replay is keyed to a stream offset");
  } finally {
    await server.close();
  }
});

test("a finished slot's replay reproduces its result", async () => {
  const { server, settlement } = await harness();
  try {
    const verdict = await settlement.verifyReplay(HEADLINE);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    assert.equal(verdict.recorded_enum, 1);
    assert.equal(verdict.expected_enum, 1);
  } finally {
    await server.close();
  }
});

test("an invalidated market explains which rule invalidated it", async () => {
  const { server, store, settlement } = await harness();
  try {
    store.upsertMarket({ market_address: HEADLINE, final_outcome: 4, block_number: 9 });
    const record = await settlement.record(HEADLINE);
    assert.equal(record.resolution.outcome_label, "invalid");
    assert.deepEqual(record.resolution.payout_vector, { a: "0.5", b: "0.5" });

    // These resolvers agreed, so the market did not fail for want of a quorum.
    // With nothing on chain saying why, the record says that rather than
    // blaming them — and still explains what Invalid means for the reader.
    assert.equal(record.invalidation.reason_code, "unknown");
    assert.match(record.invalidation.explanation, /not recorded|collateral is returned/i);

    // Where the reason IS derivable, it is named.
    store.appendSkip({ market: HEADLINE, epoch: 1n, selector: "0xa", reason: "0x", block_number: 7 });
    store.appendSkip({ market: HEADLINE, epoch: 2n, selector: "0xa", reason: "0x", block_number: 8 });
    assert.equal((await settlement.record(HEADLINE)).invalidation.reason_code, "persistent_skip");
  } finally {
    await server.close();
  }
});

test("account portfolio and history return holdings, pending actions, and claims", async () => {
  const { server, base } = await harness();
  try {
    const portfolio = await get(base, "/v1/accounts/0xTRADER/portfolio");
    assert.equal(portfolio.body.holdings.length, 1);
    assert.equal(portfolio.body.holdings[0].position_a, "90");
    assert.equal(portfolio.body.claims[0].outcome_label, "outcome_a");

    const history = await get(base, "/v1/accounts/0xTRADER/history");
    assert.equal(history.body.actions.length, 1);
  } finally {
    await server.close();
  }
});

test("the allowlist gates the interface and says so honestly", async () => {
  const allowlist = new Allowlist({ addresses: ["0xALLOWED"], enabled: true });
  await allowlist.acceptTerms("0xALLOWED", "testnet-1");
  const { server, base } = await harness({ allowlist });
  try {
    const denied = await get(base, "/v1/rooms/room-1");
    assert.equal(denied.status, 403);
    assert.match(denied.body.copy, /contracts remain open on a public test network/);
    assert.match(denied.body.copy, /no real-world value/);
    assert.ok(!/jurisdiction guarantee\.$/.test(denied.body.copy.replace(DENIAL_COPY, "")), "copy is the frozen denial text");

    const noTerms = await get(base, "/v1/rooms/room-1", { "x-tm-address": "0xOTHER" });
    assert.equal(noTerms.status, 403);

    const allowed = await get(base, "/v1/rooms/room-1", { "x-tm-address": "0xALLOWED" });
    assert.equal(allowed.status, 200);

    // Health stays reachable so an operator can see why access failed.
    const health = await get(base, "/v1/health");
    assert.equal(health.status, 200);
  } finally {
    await server.close();
  }
});

test("disabling the allowlist changes no market behaviour", async () => {
  const allowlist = new Allowlist({ addresses: [], enabled: false });
  const { server, base, settlement } = await harness({ allowlist });
  try {
    const open = await get(base, "/v1/rooms/room-1");
    assert.equal(open.status, 200);
    assert.equal((await settlement.verifyReplay(HEADLINE)).ok, true, "settlement is identical with the gate off");
  } finally {
    await server.close();
  }
});

test("the scoreboard counts a corrected fact once, at its corrected value", async () => {
  // /scores hands out the session's facts. A client that adds them up gets a
  // provider's restatement counted twice — the original figure plus the one
  // that replaced it — so the endpoint that calls itself a scoreboard has to
  // serve the standing rather than leave that arithmetic to whoever reads it.
  const { server, base, connector } = await harness();
  try {
    const restated = [{ tid: 1, time: 4000, closedPnl: "200", fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" }];
    await connector.ingestBatch({
      rawBytes: JSON.stringify(restated),
      rawQuery: { endpoint: "info", type: "userFillsByTime", user: "0xA", startTime: 0, endTime: 9000 },
      drafts: normalizeFillsResponse("alice", "0xA", restated),
    });

    const scores = await get(base, "/v1/rooms/room-1/scores");
    assert.equal(scores.status, 200);
    const alice = scores.body.standing.find((row) => row.participant === "alice");
    assert.equal(alice.realized_pnl_usd, "200", "1200 was restated to 200, not added to it");
    assert.equal(alice.baseline_account_value_usd, "10000");

    const trades = scores.body.events.filter((event) => event.kind === "trade_closed");
    assert.equal(trades.length, 2, "both the fact and its restatement stay in the record");
    assert.ok(trades[1].corrects, "and the restatement says what it restates");
  } finally {
    await server.close();
  }
});
