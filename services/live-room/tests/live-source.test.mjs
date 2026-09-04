// The live source, driven the way a live source actually behaves.
//
// The poller existed and was exercised only against a scripted replay. A real
// provider reconnects mid-session, repeats fills across overlapping windows,
// restates figures it already sent, and goes down. Each of those has a
// different right answer, and getting one wrong is not a degraded experience —
// it is a market settling against evidence that says something else.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { privateKeyToAccount } from "viem/accounts";

import { SourceConnector, makeSignatureVerifier } from "../src/connector/connector.mjs";
import { HyperliquidPoller } from "../src/connector/hyperliquid.mjs";
import { openDatabase, SqliteEventStore, SqliteKeyValue, SqliteRawArchive } from "../src/ports/sqlite-stores.mjs";
import { foldMetrics } from "../src/domain/conditions.mjs";
import { verifyChain } from "../src/domain/eventlog.mjs";

const KEY = "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82";
const ALICE = "0x000000000000000000000000000000000000000a";
const BOB = "0x000000000000000000000000000000000000000b";
const PARTICIPANTS = [
  { key: "alice", address: ALICE },
  { key: "bob", address: BOB },
];

/** A provider that can be told to fail, and that repeats its window overlaps. */
function provider() {
  const fills = new Map([
    [ALICE, []],
    [BOB, []],
  ]);
  const state = { down: false, requests: 0, windows: [], baselines: new Map([[ALICE, "10000"], [BOB, "10000"]]) };

  return {
    state,
    addFill(address, fill) {
      fills.get(address).push(fill);
    },
    restate(address, tid, closedPnl) {
      const list = fills.get(address);
      const index = list.findIndex((entry) => entry.tid === tid);
      list[index] = { ...list[index], closedPnl };
    },
    async fetch(_url, init) {
      state.requests += 1;
      if (state.down) throw new Error("ECONNRESET");
      const body = JSON.parse(init.body);
      if (body.type === "userFillsByTime") state.windows.push({ user: body.user, startTime: body.startTime, endTime: body.endTime });
      if (body.type === "clearinghouseState") {
        const payload = { marginSummary: { accountValue: state.baselines.get(body.user) } };
        return { ok: true, text: async () => JSON.stringify(payload) };
      }
      // A real window returns everything in range, so overlapping polls repeat
      // — up to the endpoint's page cap, which truncates the rest.
      const inWindow = fills
        .get(body.user)
        .filter((fill) => fill.time >= body.startTime && fill.time <= body.endTime)
        .sort((a, b) => a.time - b.time);
      const page = state.pageCap ? inWindow.slice(0, state.pageCap) : inWindow;
      return { ok: true, text: async () => JSON.stringify(page) };
    },
  };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-live-"));
  const db = openDatabase(join(dir, "room.db"));
  const store = new SqliteEventStore(db);
  const source = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store,
    rawArchive: new SqliteRawArchive(db),
    signer: privateKeyToAccount(KEY),
    clock: () => new Date().toISOString(),
  });
  return { dir, db, store, source, cursors: new SqliteKeyValue(db), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const fill = (tid, time, closedPnl) => ({ tid, time, closedPnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" });

test("overlapping windows repeat fills, and the log records each once", async () => {
  const { store, source, clean } = scratch();
  const api = provider();
  try {
    let now = 10_000;
    const poller = new HyperliquidPoller({
      connector: source,
      participants: PARTICIPANTS,
      fetchImpl: api.fetch,
      now: () => now,
    });
    await poller.captureBaselines();

    api.addFill(ALICE, fill(1, 11_000, "100"));
    now = 12_000;
    await poller.pollOnce();

    // The next window overlaps by design, so the provider returns the same
    // fill again. A gap would not heal itself; a duplicate must not count.
    now = 14_000;
    await poller.pollOnce();
    now = 16_000;
    await poller.pollOnce();

    const trades = (await store.all()).filter((event) => event.kind === "trade_closed");
    assert.equal(trades.length, 1, "one fill, seen three times, recorded once");
    assert.equal(foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd, "100");
  } finally {
    clean();
  }
});

test("a provider outage stops the log rather than corrupting it, and backfills on return", async () => {
  const { store, source, clean } = scratch();
  const api = provider();
  try {
    let now = 10_000;
    const poller = new HyperliquidPoller({
      connector: source,
      participants: PARTICIPANTS,
      fetchImpl: api.fetch,
      now: () => now,
    });
    await poller.captureBaselines();

    api.state.down = true;
    now = 12_000;
    await assert.rejects(() => poller.pollOnce(), /ECONNRESET/, "an outage is an error, not an empty poll");

    const duringOutage = (await store.all()).length;

    // Fills happened while the provider was unreachable.
    api.addFill(ALICE, fill(1, 12_500, "40"));
    api.addFill(ALICE, fill(2, 13_500, "60"));

    api.state.down = false;
    now = 15_000;
    await poller.pollOnce();

    assert.ok((await store.all()).length > duringOutage, "the window that failed is re-fetched, not skipped");
    assert.equal(
      foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd,
      "100",
      "both fills that happened during the outage are in the log"
    );
  } finally {
    clean();
  }
});

test("a restated fill reaches the log as a correction and is counted once", async () => {
  const { store, source, clean } = scratch();
  const api = provider();
  try {
    let now = 10_000;
    const poller = new HyperliquidPoller({
      connector: source,
      participants: PARTICIPANTS,
      fetchImpl: api.fetch,
      now: () => now,
    });
    await poller.captureBaselines();

    api.addFill(ALICE, fill(1, 11_000, "100"));
    now = 12_000;
    await poller.pollOnce();

    // The provider corrects the figure it already reported.
    api.restate(ALICE, 1, "70");
    now = 14_000;
    const corrected = await poller.pollOnce();

    assert.equal(corrected.length, 1);
    assert.ok(corrected[0].corrects, "it names the event it supersedes");
    assert.equal(foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd, "70");
  } finally {
    clean();
  }
});

test("a reconnected poller resumes from its cursor instead of refetching history", async () => {
  const { db, store, source, cursors, clean } = scratch();
  const api = provider();
  try {
    let now = 10_000;
    const build = () =>
      new HyperliquidPoller({
        connector: source,
        participants: PARTICIPANTS,
        fetchImpl: api.fetch,
        now: () => now,
        cursors,
      });

    const before = build();
    await before.captureBaselines();
    api.addFill(ALICE, fill(1, 11_000, "100"));
    now = 12_000;
    await before.pollOnce();

    // A restart: a new poller against the same durable state.
    const requestsBefore = api.state.requests;
    const after = build();
    now = 14_000;
    await after.pollOnce();

    // The window the restarted poller actually asked for, not the last one the
    // log happens to hold: a poll that appends nothing still made a request,
    // and that request is what proves the cursor survived.
    const asked = api.state.windows.filter((entry) => entry.user === ALICE).at(-1);
    assert.ok(
      asked.startTime > 0,
      `a restarted poller must not start its window at the beginning of time (asked from ${asked.startTime})`
    );
    assert.ok(api.state.requests > requestsBefore);
    assert.equal(foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd, "100", "and no fill is double counted");
  } finally {
    clean();
  }
});

test("the log a live session produces verifies end to end", async () => {
  const { store, source, clean } = scratch();
  const api = provider();
  try {
    let now = 10_000;
    const poller = new HyperliquidPoller({
      connector: source,
      participants: PARTICIPANTS,
      fetchImpl: api.fetch,
      now: () => now,
    });
    await poller.captureBaselines();

    for (const [index, amount] of [["100"], ["50"], ["25"]].entries()) {
      api.addFill(ALICE, fill(index + 1, 11_000 + index * 1_000, amount[0]));
      now = 12_000 + index * 2_000;
      await poller.pollOnce();
    }
    // A restatement of a fill from earlier in the session. The incremental
    // window has already moved past it, so only a reconciliation sweep can see
    // it — and without one the market settles on a figure the provider has
    // since withdrawn.
    api.restate(ALICE, 2, "30");
    now = 20_000;
    await poller.pollOnce();
    await poller.reconcile();

    const result = await verifyChain(await store.all(), {
      verifySignature: makeSignatureVerifier(privateKeyToAccount(KEY).address),
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
    assert.equal(foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd, "155");
  } finally {
    clean();
  }
});


test("a window the provider truncates is paged through, not skipped", async () => {
  // `userFillsByTime` answers at most one page. A poller that treats a full
  // page as the whole window advances its cursor past everything the provider
  // could not fit, and those fills are gone: not late, not duplicated — gone,
  // from a log that a market settles on.
  const api = provider();
  const { store, source, clean } = scratch();
  try {
    api.state.pageCap = 3;
    for (let index = 1; index <= 7; index++) api.addFill(ALICE, fill(index, 1_000 + index * 10, "100"));

    const poller = new HyperliquidPoller({
      connector: source,
      participants: [{ key: "alice", address: ALICE }],
      fetchImpl: api.fetch,
      now: () => 100_000,
      pageLimit: 3,
    });
    await poller.pollOnce();

    const trades = (await store.all()).filter((event) => event.kind === "trade_closed");
    assert.equal(trades.length, 7, "every fill in the window has to reach the log");
    assert.equal(foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd, "700");
  } finally {
    clean();
  }
});

test("a window that cannot be paged past fails loudly rather than dropping fills", async () => {
  // Every fill in a full page shares one timestamp, so no time window can step
  // over it. There is no correct answer here — but there is a correct failure:
  // stop, and let the source go stale, rather than record a total that is
  // missing trades nobody will ever know about.
  const api = provider();
  const { store, source, clean } = scratch();
  try {
    api.state.pageCap = 3;
    for (let index = 1; index <= 6; index++) api.addFill(ALICE, fill(index, 1_000, "100"));

    const poller = new HyperliquidPoller({
      connector: source,
      participants: [{ key: "alice", address: ALICE }],
      fetchImpl: api.fetch,
      now: () => 100_000,
      pageLimit: 3,
    });
    await assert.rejects(() => poller.pollOnce(), /saturated/);
    assert.ok(
      (await store.all()).filter((event) => event.kind === "trade_closed").length <= 3,
      "what was read is kept; what could not be read is not invented"
    );
  } finally {
    clean();
  }
});

test("the reconciliation sweep pages through a truncated window too", async () => {
  const api = provider();
  const { store, source, clean } = scratch();
  try {
    api.state.pageCap = 2;
    for (let index = 1; index <= 5; index++) api.addFill(ALICE, fill(index, 1_000 + index * 10, "100"));

    const poller = new HyperliquidPoller({
      connector: source,
      participants: [{ key: "alice", address: ALICE }],
      fetchImpl: api.fetch,
      now: () => 100_000,
      pageLimit: 2,
      reconcileLookbackMs: 100_000,
    });
    await poller.reconcile(100_000);
    assert.equal((await store.all()).filter((event) => event.kind === "trade_closed").length, 5);
  } finally {
    clean();
  }
});


test("the poller speaks real HTTP: a failed response is an error, a dead socket is an error", async () => {
  // Every other test here hands the poller a fetch stub, which proves the
  // logic and nothing about the transport. This one runs its default fetch
  // against a real server, because "the provider returned 500" and "the
  // provider hung up" have to reach the operator as failures rather than as an
  // empty window that looks exactly like a quiet market.
  const behaviour = { mode: "ok" };
  const fills = [fill(1, 1_000, "250")];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (behaviour.mode === "dead") return void request.socket.destroy();
      if (behaviour.mode === "error") {
        response.writeHead(503, { "content-type": "text/plain" });
        return void response.end("upstream unavailable");
      }
      const query = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(query.type === "clearinghouseState" ? { marginSummary: { accountValue: "10000" } } : fills));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const infoUrl = `http://127.0.0.1:${server.address().port}/info`;
  const { store, source, clean } = scratch();

  try {
    const poller = new HyperliquidPoller({
      connector: source,
      participants: [{ key: "alice", address: ALICE }],
      infoUrl,
      now: () => 50_000,
    });

    await poller.captureBaselines();
    await poller.pollOnce();
    assert.equal(foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd, "250");

    behaviour.mode = "error";
    await assert.rejects(() => poller.pollOnce(), /503/, "an HTTP failure is not an empty window");

    behaviour.mode = "dead";
    await assert.rejects(() => poller.pollOnce(), "a dropped connection is not an empty window");

    behaviour.mode = "ok";
    await poller.pollOnce();
    assert.equal(
      foldMetrics(await store.all()).get("alice").cumRealizedPnlUsd,
      "250",
      "and recovery re-reads rather than re-counts"
    );
  } finally {
    clean();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
