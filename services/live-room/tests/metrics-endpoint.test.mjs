// Production monitoring.
//
// The metrics existed and were exercised only inside the game-day runner, so a
// running deployment produced no signal at all: an operator had no way to know
// the indexer had stalled, the gate had gone quiet, or the stream had dropped,
// short of reading the page and guessing.
//
// A Prometheus text endpoint because it needs no credential, no vendor and no
// account — anything that scrapes HTTP can read it, which is what makes it
// finishable here rather than describable.

import test from "node:test";
import assert from "node:assert/strict";

import { renderMetrics, PROMETHEUS_CONTENT_TYPE } from "../src/observability/exporter.mjs";

test("the exporter renders real numbers in the text exposition format", () => {
  const body = renderMetrics({
    room_ids: ["alpha", "beta"],
    chain_head: 120,
    indexer_cursor: 118,
    indexer_health: "current",
    stream_health: "live",
    source_health: "fresh",
    rooms_indexed: 2,
    markets_indexed: 7,
    chat_messages: 12,
    non_chain_history_durable: true,
    config_warning: null,
  });

  assert.match(body, /^# HELP tradermarket_chain_head/m);
  assert.match(body, /^# TYPE tradermarket_chain_head gauge/m);
  assert.match(body, /^tradermarket_chain_head 120$/m);
  assert.match(body, /^tradermarket_indexer_lag_blocks 2$/m);
  assert.match(body, /^tradermarket_markets_indexed 7$/m);
  assert.match(body, /^tradermarket_rooms_served 2$/m);
  assert.match(body, /^tradermarket_history_durable 1$/m);
});

test("health strings become one gauge per state, so a scrape can alert on either", () => {
  const body = renderMetrics({
    room_ids: ["alpha"],
    chain_head: 10,
    indexer_cursor: 4,
    indexer_health: "delayed",
    stream_health: "unknown",
    source_health: "stale",
  });

  // Exactly one of each family is 1: an alert rule should not have to parse a
  // label value out of a string.
  assert.match(body, /^tradermarket_indexer_health\{state="delayed"\} 1$/m);
  assert.match(body, /^tradermarket_indexer_health\{state="current"\} 0$/m);
  assert.match(body, /^tradermarket_stream_health\{state="unknown"\} 1$/m);
  assert.match(body, /^tradermarket_source_health\{state="stale"\} 1$/m);
  assert.match(body, /^tradermarket_indexer_lag_blocks 6$/m);
});

test("an unknown chain head is absent rather than reported as zero", () => {
  const body = renderMetrics({ room_ids: ["alpha"], chain_head: null, indexer_cursor: 4 });

  // A zero here would read as "the chain is at block 0", and a lag computed
  // from it would page someone about a stall that is not happening.
  assert.ok(!/^tradermarket_chain_head /m.test(body), "no head means no metric");
  assert.ok(!/^tradermarket_indexer_lag_blocks /m.test(body), "and no lag derived from it");
  assert.match(body, /^tradermarket_indexer_cursor 4$/m);
});

test("a configuration warning is exported so it can page someone", () => {
  const clean = renderMetrics({ room_ids: ["a"], config_warning: null });
  assert.match(clean, /^tradermarket_config_warning 0$/m);

  const broken = renderMetrics({ room_ids: ["a"], config_warning: "room id does not match the contract" });
  assert.match(broken, /^tradermarket_config_warning 1$/m);
});

test("the exposition is well-formed: no NaN, no undefined, one trailing newline", () => {
  const body = renderMetrics({ room_ids: [], chain_head: undefined, indexer_cursor: undefined });
  assert.ok(!/NaN|undefined|null/.test(body), body);
  assert.ok(body.endsWith("\n"));
  assert.equal(PROMETHEUS_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
});

test("the running server exposes /metrics from its own real state", async () => {
  const { buildService, configFromEnv } = await import("../src/app.mjs");
  const service = buildService(
    configFromEnv({
      TM_ROOMS: "alpha=0x2222222222222222222222222222222222222222",
      TM_RPC_URL: "http://127.0.0.1:8545",
      TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
      TM_CHAIN_ID: "31337",
      TM_ROOM_API_URL: "http://127.0.0.1:8787",
    })
  );
  try {
    const address = await service.server.listen(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/plain/);

    const body = await response.text();
    assert.match(body, /^tradermarket_rooms_served 1$/m);
    // Nothing has been indexed and no head observed, so neither is claimed.
    assert.ok(!/^tradermarket_chain_head /m.test(body));
    assert.match(body, /^tradermarket_indexer_health\{state="unknown"\} 1$/m);
    assert.match(body, /^tradermarket_history_durable 0$/m, "an in-memory deployment says so in its metrics");
  } finally {
    await service.stop();
  }
});
