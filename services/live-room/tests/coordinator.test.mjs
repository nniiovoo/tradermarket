// Issues 07 + 08: the Coordinator derives and publishes; the Publisher signs.
// The Coordinator holds no key, asserts no unsupported state, and every frame
// carries provenance. Publication needs both authorities.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { LiveRoomCoordinator, PRESENTATION_ONLY_TYPES } from "../src/coordinator/coordinator.mjs";
import { ProgramPublisher, firstTemplateCatalog } from "../src/publisher/publisher.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { ChainIndexer, GATE_STATE } from "../src/indexer/indexer.mjs";
import { MemoryEventStore, MemoryRawArchive } from "../src/ports/stores.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { normalizeFillsResponse } from "../src/connector/hyperliquid.mjs";
import { GateAuthority } from "../src/gate/authority.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";

const FACTORY = "0xFACTORY";
const ROOM = "0xROOM";
const HEADLINE = "0xM0";
const ROOM_ID = "room-1";
const connectorAccount = privateKeyToAccount(generatePrivateKey());
const gateAccount = privateKeyToAccount(generatePrivateKey());

class FakeLogSource {
  constructor(logs) {
    this.logs = logs;
  }

  async getLogs({ fromBlock, toBlock }) {
    return this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
  }
}

function baseLogs() {
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
        streamUrl: "https://www.youtube.com/live/dQw4w9WgXcQ",
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
        undecidedThroughSequence: 10n,
        opensAt: 30n,
      },
    },
  ];
}

/** Market state as the real getters return it. */
function marketState(overrides = {}) {
  return {
    gateState: GATE_STATE.open,
    reserveA: 1000n,
    reserveB: 1000n,
    spotPriceA: 500000n,
    totalLpShares: 1000n,
    winnerRewardPool: 0n,
    pendingCollateral: 0n,
    collateralBacking: 1000n,
    unclaimedLpFees: 0n,
    currentEpoch: 1n,
    lastSafeSequence: 10n,
    finalOutcome: 0,
    provisionalAt: 0n,
    ...overrides,
  };
}

/** A log that merely touches a market so its state is refreshed. */
function touchLog(blockNumber, market = HEADLINE) {
  return {
    blockNumber,
    logIndex: 50 + blockNumber,
    address: market,
    event: "EpochMarkedSafe",
    args: { epoch: 1n, sourceSequence: 10n },
  };
}

async function harness({ logs = baseLogs(), publisherApi = null, states = new Map() } = {}) {
  const store = new ProjectionStore();
  const indexer = new ChainIndexer({
    store,
    logs: new FakeLogSource(logs),
    reader: { async readMarketState(market) {
      // Case-insensitive, like a real chain client.
      const wanted = String(market).toLowerCase();
      const found = [...states.entries()].find(([address]) => String(address).toLowerCase() === wanted);
      return found?.[1] ?? marketState();
    } },
  });
  const eventLog = new MemoryEventStore();
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store: eventLog,
    rawArchive: new MemoryRawArchive(),
    signer: connectorAccount,
    clock: () => new Date().toISOString(),
  });
  const published = [];
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog,
    publishTo: (frame) => published.push(frame),
    config: { freshnessThresholdMs: 20_000, retention: 100, maxOpenSlots: 2 },
    publisherApi,
  });
  return { store, indexer, eventLog, connector, coordinator, published, logs };
}

async function ingest(connector, participant, fills, endMs) {
  await connector.ingestBatch({
    rawBytes: JSON.stringify(fills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: "0xA", startTime: 0, endTime: endMs },
    drafts: normalizeFillsResponse(participant, "0xA", fills),
  });
}

const fill = (tid, time, pnl) => ({ tid, time, closedPnl: pnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" });

test("the coordinator holds no chain key and exposes no order path", () => {
  const source = readFileSync(new URL("../src/coordinator/coordinator.mjs", import.meta.url), "utf8");
  for (const forbidden of ["privateKey", "signTypedData", "signMessage", "sendTransaction", "writeContract"]) {
    assert.ok(!source.includes(forbidden), `coordinator must not reference ${forbidden}`);
  }
  const coordinator = new LiveRoomCoordinator({
    roomId: "r",
    store: new ProjectionStore(),
    eventLog: new MemoryEventStore(),
    publishTo: () => {},
    config: { freshnessThresholdMs: 1 },
  });
  for (const method of ["submitBuy", "submitSell", "submitOrder", "publishSlot", "markEpochSafe", "attestResult"]) {
    assert.equal(typeof coordinator[method], "undefined", `coordinator must not expose ${method}`);
  }
});

test("every published frame carries provenance", async () => {
  const { indexer, coordinator, published } = await harness();
  await indexer.syncTo(2);
  coordinator.tick(Date.now());
  coordinator.setStreamHealth("live");
  coordinator.heartbeat();

  assert.ok(published.length > 0);
  for (const frame of published) {
    const hasProvenance =
      frame.chain !== undefined || frame.source_seq !== undefined || frame.presentation_only === true;
    assert.ok(hasProvenance, `frame ${frame.type} lacks provenance`);
    if (frame.presentation_only) {
      assert.ok(PRESENTATION_ONLY_TYPES.has(frame.type), `${frame.type} is not an allowed presentation-only type`);
    }
  }
});

test("the room snapshot carries the indexed stream URL to its audience", async () => {
  const { indexer, coordinator } = await harness();
  await indexer.syncTo(2);

  const slot = coordinator.snapshot().program.slots[0];
  assert.equal(slot.stream_url, "https://www.youtube.com/live/dQw4w9WgXcQ");
});

test("a frame without provenance is refused", async () => {
  const { coordinator } = await harness();
  assert.throws(() => coordinator.publish("slot.price_changed", { x: 1 }), /no provenance/);
});

test("room sequence is gap-free and a stale cursor triggers resync", async () => {
  const { indexer, coordinator } = await harness();
  await indexer.syncTo(2);
  for (let i = 0; i < 5; i++) {
    coordinator.setViewers(i);
  }
  const seqs = coordinator.frames.map((frame) => frame.seq);
  assert.deepEqual(seqs, seqs.map((_, index) => seqs[0] + index), "gap-free ascending");

  const since = coordinator.framesSince(seqs[0]);
  assert.equal(since.resync, false);
  assert.equal(since.frames[0].seq, seqs[0] + 1);

  coordinator.frames.splice(0, 3); // simulate retention eviction
  const stale = coordinator.framesSince(0);
  assert.equal(stale.resync, true);
  assert.ok(stale.snapshot);
});

test("a restarted coordinator rebuilds identical state from the indexer and the log", async () => {
  const logs = baseLogs().concat([touchLog(3)]);
  const first = await harness({ logs });
  await first.indexer.syncTo(3);
  await ingest(first.connector, "alice", [fill(1, 1000, "50")], 2000);
  const snapshotA = first.coordinator.snapshot(5000);

  const second = await harness({ logs });
  await second.indexer.syncTo(3);
  await ingest(second.connector, "alice", [fill(1, 1000, "50")], 2000);
  const snapshotB = second.coordinator.snapshot(5000);

  // seq differs (fresh instance), everything derived matches.
  assert.deepEqual({ ...snapshotB, seq: 0 }, { ...snapshotA, seq: 0 });
});

test("stream, source, and connection are three independent signals", async () => {
  const { indexer, coordinator, connector, eventLog } = await harness({ logs: baseLogs().concat([touchLog(3)]) });
  await indexer.syncTo(3);
  await ingest(connector, "alice", [fill(1, 1000, "50")], 2000);
  coordinator.observeEventLogTip(await eventLog.tip());

  coordinator.setStreamHealth("unavailable");
  const withFreshSource = coordinator.snapshot(Date.parse("1970-01-01T00:00:02.000Z"));
  assert.equal(withFreshSource.health.stream, "unavailable");
  assert.equal(withFreshSource.health.source, "fresh", "a dead stream does not make the feed stale");

  coordinator.setStreamHealth("live");
  const withStaleSource = coordinator.snapshot(Date.parse("1970-01-01T01:00:00.000Z"));
  assert.equal(withStaleSource.health.stream, "live");
  assert.equal(withStaleSource.health.source, "stale", "a live stream does not make the feed fresh");
});

test("focus advances to the newest tradable micro slot and back to the headline", async () => {
  const MICRO = "0xM1";
  const logs = baseLogs().concat([
    touchLog(3),
    {
      blockNumber: 4,
      logIndex: 90,
      address: FACTORY,
      event: "MarketCreated",
      args: {
        market: MICRO,
        participantA: "0xPA",
        participantB: "0xPB",
        roomId: ROOM_ID,
        slotIndex: 1,
        templateId: "tpl-threshold-v1",
        conditionHash: "0xC1",
        question: "Micro?",
        streamUrl: "",
      },
    },
    {
      blockNumber: 4,
      logIndex: 91,
      address: ROOM,
      event: "SlotPublished",
      args: {
        market: MICRO,
        slotIndex: 1,
        templateId: "tpl-threshold-v1",
        requestHash: "0xR1",
        conditionHash: "0xC1",
        nonce: 2n,
        undecidedThroughSequence: 20n,
        opensAt: 60n,
      },
    },
    touchLog(5, MICRO),
  ]);
  const states = new Map([
    [HEADLINE, marketState()],
    [MICRO, marketState()],
  ]);
  const { indexer, coordinator } = await harness({ logs, states });

  await indexer.syncTo(3);
  coordinator.tick();
  assert.equal(coordinator.focusSlotIndex, 0, "headline holds focus alone");

  await indexer.syncTo(5);
  coordinator.tick();
  assert.equal(coordinator.focusSlotIndex, 1, "focus moves to the open micro slot");

  // The micro slot closes: its own ForecastingClosed is what closes it.
  indexer.apply({
    blockNumber: 6,
    logIndex: 92,
    address: MICRO,
    event: "ForecastingClosed",
    args: { epoch: 4n, decisiveSequence: 30n },
  });
  coordinator.tick();
  assert.equal(coordinator.focusSlotIndex, 0, "focus returns to the headline when the micro closes");
});

test("publication requires BOTH the publisher role and a gate permit", async () => {
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xC0");
  const eventLog = new MemoryEventStore();
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store: eventLog,
    rawArchive: new MemoryRawArchive(),
    signer: connectorAccount,
    clock: () => new Date().toISOString(),
  });
  await ingest(connector, "alice", [fill(1, 1000, "10")], 2000);

  const headlineCondition = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "10000" } };
  const gate = new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store: eventLog,
    signer: gateAccount,
    conditions: new Map([[HEADLINE, headlineCondition]]),
    config: {
      epochDurationS: 10,
      sourceFinalityDelayS: 10,
      freshnessThresholdMs: 60_000,
      maxPermitLifetimeS: 300,
      headlineMarket: HEADLINE,
    },
  });

  const publishCalls = [];
  const publisher = new ProgramPublisher({
    chain: {
      async publishSlot(request, permit, signature) {
        publishCalls.push({ request, permit, signature });
        if (!signature) throw new Error("PermitInvalidSigner");
        return "0xM1";
      },
    },
    gate,
    catalog: firstTemplateCatalog(),
    config: { minAnnounceDelay: 30 },
  });

  // Approved, undecided question: published, carrying a gate signature.
  const ok = await publisher.requestSlot({
    slotIndex: 1,
    templateId: "tpl-threshold-v1",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "500" },
    // The question is rendered from the params, so the words cannot claim a
    // different threshold than the rule settles on (issue 43).
  });
  assert.equal(ok.status, "published");
  assert.ok(publishCalls[0].signature.startsWith("0x"), "the chain call carried the gate signature");
  assert.equal(publishCalls[0].request.winnerRewardBps, 0, "threshold slots carry no winner reward");

  // Already-decided question: refused before it reaches the chain.
  const refused = await publisher.requestSlot({
    slotIndex: 2,
    templateId: "tpl-threshold-v1",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "5" },
  });
  assert.equal(refused.status, "refused");
  assert.match(refused.reason, /decided/);
  assert.equal(publishCalls.length, 1, "no chain call for a refused permit");

  // Out-of-catalog template: rejected without asking the gate.
  const rejected = await publisher.requestSlot({ slotIndex: 2, templateId: "tpl-unknown", params: {}, question: "?" });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.reason, /not approved/);

  // Announce delay below the frozen minimum.
  const short = await publisher.requestSlot({
    slotIndex: 2,
    templateId: "tpl-threshold-v1",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "900" },
    question: "?",
    announceDelay: 5,
  });
  assert.equal(short.status, "rejected");
  assert.match(short.reason, /announce delay/);
});

test("the coordinator can only REQUEST a slot, under the program's opening rules", async () => {
  const requests = [];
  const publisherApi = {
    async requestSlot(candidate) {
      requests.push(candidate);
      return { status: "published" };
    },
  };
  const logs = baseLogs().concat([touchLog(3)]);
  const { indexer, coordinator, connector, eventLog } = await harness({ logs, publisherApi });
  await indexer.syncTo(3);
  await ingest(connector, "alice", [fill(1, 1000, "50")], 2000);
  coordinator.observeEventLogTip(await eventLog.tip());
  const now = Date.parse("1970-01-01T00:00:02.000Z");

  const candidate = { templateId: "tpl-threshold-v1", templateParamsKey: "k1", params: {}, question: "?" };
  const accepted = await coordinator.maybeRequestSlot(candidate, now);
  assert.equal(accepted.requested, true);
  assert.equal(requests.length, 1);

  // Stale source blocks a request.
  const stale = await coordinator.maybeRequestSlot(
    { ...candidate, templateParamsKey: "k2" },
    Date.parse("1970-01-01T01:00:00.000Z")
  );
  assert.equal(stale.requested, false);
  assert.equal(stale.reason, "source stale");
});

test("an unbacked headline blocks micro requests", async () => {
  const logs = baseLogs().concat([touchLog(3)]);
  const { indexer, coordinator, connector } = await harness({
    logs,
    states: new Map([[HEADLINE, marketState({ totalLpShares: 0n })]]),
    publisherApi: { async requestSlot() {
      throw new Error("must not be called");
    } },
  });
  await indexer.syncTo(3);
  await ingest(connector, "alice", [fill(1, 1000, "50")], 2000);
  const result = await coordinator.maybeRequestSlot(
    { templateId: "tpl-threshold-v1", templateParamsKey: "k", params: {}, question: "?" },
    Date.parse("1970-01-01T00:00:02.000Z")
  );
  assert.equal(result.requested, false);
  assert.equal(result.reason, "headline unbacked");
});

test("a viewer count nothing measures is absent, not zero", () => {
  const store = new ProjectionStore();
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog: new MemoryEventStore(),
    publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });

  // Nothing counts viewers in this deployment. Reporting 0 is a measurement
  // claim — "nobody is watching" — where the truth is "we do not count".
  assert.equal(coordinator.snapshot().viewers.count, null);
  assert.equal(coordinator.snapshot().viewers.measured, false);

  coordinator.setViewers(41);
  assert.equal(coordinator.snapshot().viewers.count, 41);
  assert.equal(coordinator.snapshot().viewers.measured, true);

  coordinator.setViewers(0);
  assert.equal(coordinator.snapshot().viewers.count, 0, "a measured zero is a real zero");
  assert.equal(coordinator.snapshot().viewers.measured, true);
});

test("a market row with no price yet reports no price, not the string 'undefined'", () => {
  const store = new ProjectionStore();
  store.upsertRoom({ room_id: "room-1", live_room_address: "0xroom", state: "live", block_number: 5 });
  store.upsertSlot({
    room_id: "room-1", slot_index: 0, state: "open", question: "Who wins?",
    market_address: "0xm0", condition_hash: "0xc0", block_number: 5,
  });
  // A market row exists as soon as MarketCreated is indexed; implied_prob_a is
  // only populated later by refreshTouchedMarkets. Guarding on the row rather
  // than the field serves `String(undefined)` — and the app then renders NaN¢
  // and a probability bar with width: NaN%.
  store.upsertMarket({ market_address: "0xm0", room_id: "room-1", slot_index: 0, block_number: 11 });

  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1", store, eventLog: new MemoryEventStore(), publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });
  const slot = coordinator.snapshot().program.slots[0];

  assert.equal(slot.price, null, "no price is null, never a stringified undefined");
  assert.equal(slot.liquidity, null);

  store.upsertMarket({
    market_address: "0xm0", room_id: "room-1", slot_index: 0,
    implied_prob_a: 620_000n, total_lp_shares: 5n, block_number: 12,
  });
  const withPrice = coordinator.snapshot().program.slots[0];
  assert.equal(withPrice.price.implied_prob_a, "620000");
  assert.equal(withPrice.liquidity.total_lp_shares, "5");
});

test("the slot view reports the fee rate the contract charges", () => {
  const store = new ProjectionStore();
  store.upsertRoom({ room_id: "room-1", live_room_address: "0xroom", state: "live", block_number: 5 });
  store.upsertSlot({
    room_id: "room-1", slot_index: 0, state: "open", question: "Who wins?",
    market_address: "0xm0", condition_hash: "0xc0", block_number: 5,
  });
  // The rate lives on the market row, read from the contract's own getter.
  // `SlotPublished` does not carry it, and the off-chain slot metadata is empty
  // in production — so reading it only from the slot reported null forever, and
  // every surface quoting a rate had nothing real to quote.
  store.upsertMarket({
    market_address: "0xm0", room_id: "room-1", slot_index: 0,
    winner_reward_bps: 100, implied_prob_a: 500_000n, total_lp_shares: 0n, block_number: 11,
  });

  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1", store, eventLog: new MemoryEventStore(), publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });
  assert.equal(coordinator.snapshot().program.slots[0].winner_reward_bps, 100);

  store.upsertMarket({ market_address: "0xm0", room_id: "room-1", slot_index: 0, winner_reward_bps: 0, block_number: 12 });
  assert.equal(
    coordinator.snapshot().program.slots[0].winner_reward_bps,
    0,
    "zero is a real rate, not a missing one"
  );
});

test("an unfunded market has no price, not a 50/50 one", () => {
  // MarketMath.spotPriceA returns a hardcoded 500_000 when both reserves are
  // zero. Publishing that is publishing a market price for a market nobody has
  // made a market in — rendered as a real 50%/50% bar at a named chain block.
  const store = new ProjectionStore();
  store.upsertRoom({ room_id: "room-1", live_room_address: "0xroom", state: "live", block_number: 5 });
  store.upsertSlot({
    room_id: "room-1", slot_index: 0, state: "awaiting-liquidity", question: "Who wins?",
    market_address: "0xm0", condition_hash: "0xc0", block_number: 5,
  });
  store.upsertMarket({
    market_address: "0xm0", room_id: "room-1", slot_index: 0,
    implied_prob_a: 500_000n, total_lp_shares: 0n, reserve_a: 0n, reserve_b: 0n, block_number: 11,
  });

  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1", store, eventLog: new MemoryEventStore(), publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });
  assert.equal(coordinator.snapshot().program.slots[0].price, null, "no liquidity means no price");

  store.upsertMarket({
    market_address: "0xm0", room_id: "room-1", slot_index: 0,
    implied_prob_a: 620_000n, total_lp_shares: 1_000n, reserve_a: 380n, reserve_b: 620n, block_number: 12,
  });
  assert.equal(coordinator.snapshot().program.slots[0].price.implied_prob_a, "620000");
});

test("indexer health compares the cursor with the chain, or says it does not know", () => {
  const store = new ProjectionStore();
  store.upsertRoom({ room_id: "room-1", live_room_address: "0xroom", state: "live", block_number: 5 });
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1", store, eventLog: new MemoryEventStore(), publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });

  // `staleness(this.store.cursorBlock)` compares the cursor with itself, so the
  // signal was the constant "current" and could never report a lagging indexer
  // — the one thing it exists to report.
  store.cursorBlock = 100;
  assert.equal(coordinator.snapshot().health.indexer, "unknown", "no chain head means no claim");

  coordinator.observeChainHead(101);
  assert.equal(coordinator.snapshot().health.indexer, "current");

  coordinator.observeChainHead(140);
  assert.equal(coordinator.snapshot().health.indexer, "delayed", "40 blocks behind is not current");
});

test("livestream health is unknown until something measures it", () => {
  const store = new ProjectionStore();
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1", store, eventLog: new MemoryEventStore(), publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });

  // "unavailable" is a measurement — it says the stream was checked and is
  // down. Nothing in the service checks unless a PlaybackService reports, so
  // the initial value asserted an outage that may not exist.
  assert.equal(coordinator.snapshot().stream.health, "unknown");

  coordinator.setStreamHealth("live");
  assert.equal(coordinator.snapshot().stream.health, "live");
});

test("a rejected publisher request can be retried", async () => {
  const store = new ProjectionStore();
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1", store, eventLog: new MemoryEventStore(), publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
    publisherApi: {
      async requestSlot() {
        throw new Error("publisher unavailable");
      },
    },
  });

  // A room that will pass the gates: a backed headline and a fresh source.
  store.upsertRoom({ room_id: "room-1", live_room_address: "0xroom", state: "live", block_number: 5 });
  store.upsertSlot({
    room_id: "room-1", slot_index: 0, state: "open", question: "Headline?",
    market_address: "0xm0", condition_hash: "0xc0", block_number: 5,
  });
  store.upsertMarket({
    market_address: "0xm0", room_id: "room-1", slot_index: 0,
    implied_prob_a: 500_000n, total_lp_shares: 1n, block_number: 5,
  });
  coordinator.observeEventLogTip({ observed_at: new Date().toISOString(), seq: 1 });

  const candidate = { slot_index: 1, question: "Q", template_id: "0xt", templateParamsKey: "k" };
  await assert.rejects(() => coordinator.maybeRequestSlot(candidate));
  // A rejected call left the key in pendingRequests forever, so the same
  // candidate could never be requested again after one transient failure.
  assert.equal(coordinator.pendingRequests.size, 0, "a failed request must not poison the candidate");
});

test("an unreadable chain makes the indexer signal unknown, never current", async () => {
  // The sync reads the head FIRST, so an RPC that is down throws before the
  // head is ever observed. The coordinator then kept comparing its cursor
  // against the last head it saw — which the cursor had already caught up to —
  // and reported the indexer "current". The one signal that exists to say "the
  // figures on this page are behind the chain" turned green at the exact moment
  // the chain became unreachable.
  //
  // A measurement nobody has taken recently is not a measurement.
  const { LiveRoomCoordinator } = await import("../src/coordinator/coordinator.mjs");
  const { ProjectionStore } = await import("../src/indexer/projection.mjs");
  const { MemoryEventStore } = await import("../src/ports/stores.mjs");

  const store = new ProjectionStore();
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog: new MemoryEventStore(),
    publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000, chainHeadMaxAgeMs: 30_000 },
  });

  store.cursorBlock = 5_000_000;
  coordinator.observeChainHead(5_000_000, 1_000);
  assert.equal(coordinator.snapshot(2_000).health.indexer, "current", "a fresh reading of a caught-up cursor");

  // The RPC starts failing. Nothing new is observed; the chain moves on without
  // us and the cursor stops advancing.
  assert.equal(
    coordinator.snapshot(1_000 + 60_000).health.indexer,
    "unknown",
    "nobody has read the chain head in a minute; 'current' would be a claim nobody checked"
  );

  // A successful read restores the answer.
  coordinator.observeChainHead(5_000_500, 1_000 + 60_000);
  assert.equal(coordinator.snapshot(1_000 + 61_000).health.indexer, "delayed");
});
