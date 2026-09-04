// Issue 12: the two latencies that decide whether the product is honest, and
// the alerts that catch the failures that would otherwise be silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../src/observability/metrics.mjs";

const config = { epochDurationS: 10, sourceFinalityDelayS: 10 };

test("a stalled gate pages before any action reaches its refund timeout", () => {
  const metrics = new Metrics({ config });
  // Target is finalityDelay + 3 = 13s; maxPendingTime is 90s.
  metrics.observe("gate_lag_seconds", 12);
  assert.equal(metrics.pages().length, 0, "healthy lag is silent");

  metrics.observe("gate_lag_seconds", 30);
  const page = metrics.pages().at(-1);
  assert.ok(page, "2x target pages");
  assert.ok(30 < 90, "the page fires well before the 90s refund timeout");
});

test("epoch clear latency above target pages", () => {
  const metrics = new Metrics({ config });
  metrics.observe("epoch_clear_seconds", 24);
  assert.equal(metrics.pages().length, 0);
  metrics.observe("epoch_clear_seconds", 40);
  assert.equal(metrics.pages().length, 1);
});

test("a skipped slot call pages, because that market will refund rather than settle", () => {
  const metrics = new Metrics({ config });
  metrics.increment("slot_call_skipped", 1, { market: "0xM1" });
  const page = metrics.pages().at(-1);
  assert.match(page.message, /slot call skipped/);
  assert.equal(page.labels.market, "0xM1");
});

test("resolver divergence and missed watermarks page", () => {
  const metrics = new Metrics({ config });
  metrics.increment("resolver_divergence", 1, { market: "0xM0" });
  metrics.increment("missed_watermark", 1, { epoch: 12 });
  assert.equal(metrics.pages().length, 2);
});

test("indexer lag warns then pages", () => {
  const metrics = new Metrics({ config });
  metrics.observe("indexer_lag_blocks", 5);
  assert.equal(metrics.alerts.length, 0);
  metrics.observe("indexer_lag_blocks", 20);
  assert.equal(metrics.warnings().length, 1);
  metrics.observe("indexer_lag_blocks", 80);
  assert.equal(metrics.pages().length, 1);
});

test("stream health warns and is never paged as a market incident", () => {
  const metrics = new Metrics({ config });
  metrics.increment("stream_unhealthy", 1, { health: "unavailable" });
  assert.equal(metrics.pages().length, 0, "a dead stream is not a market incident");
  assert.equal(metrics.warnings().length, 1);
});

test("any refund from missed clearance pages", () => {
  const metrics = new Metrics({ config });
  metrics.increment("refunds_from_missed_clearance", 1);
  assert.equal(metrics.pages().length, 1);
});

test("the report summarizes the operating picture", () => {
  const metrics = new Metrics({ config });
  metrics.observe("gate_lag_seconds", 11);
  metrics.observe("gate_lag_seconds", 12);
  metrics.increment("watermark", 3);
  const report = metrics.report();
  assert.equal(report.watermarks, 3);
  assert.ok(report.gate_lag_p95 >= 11);
  assert.equal(report.pages, 0);
});
