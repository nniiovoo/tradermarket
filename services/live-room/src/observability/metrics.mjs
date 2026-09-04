// Metrics and alerts (issue 12, spec: "Metrics and alerts").
//
// Two latencies decide whether the product is honest: gate lag (source
// observed_at -> on-chain safe mark) and epoch clear latency (submission ->
// executed). Everything else is availability.

export const TARGETS = {
  gate_lag_seconds: { target: (finalityDelayS) => finalityDelayS + 3, pageAt: (t) => t * 2, pageAfterS: 60 },
  epoch_clear_seconds: { target: (finalityDelayS, epochDurationS) => finalityDelayS + epochDurationS + 5 },
  indexer_lag_blocks: { warnAt: 10, pageAt: 50, target: 3 },
  room_fanout_lag_ms: { target: 500, warnAt: 2000 },
  refund_rate_from_missed_clearance: { target: 0, pageAtAnyNonZero: true },
};

/**
 * Latencies an authority publishes for the Coordinator to export.
 *
 * Lives here, beside TARGETS, because it is an observability decision: which
 * measurements cross the process boundary and become scrapeable. Named rather
 * than open — an operator writing an arbitrary key would export an arbitrary
 * metric, and a metric no alert rule references is a number nothing acts on.
 *
 * `epoch_clear_seconds` is deliberately NOT here. It is measured by the indexer,
 * inside the Coordinator, which exports /metrics itself and needs no channel. It
 * was briefly listed here as well, and the result was the same metric name
 * declared twice in one exposition — once per role from the operator block and
 * once unlabelled from the indexer gauge — which is malformed, not merely
 * redundant. A measurement belongs to exactly one publisher.
 */
export const REPORTED_LATENCIES = ["gate_lag_seconds"];

export class Metrics {
  constructor({ config }) {
    this.config = config;
    this.samples = new Map();
    this.counters = new Map();
    this.alerts = [];
  }

  observe(name, value, labels = {}) {
    const list = this.samples.get(name) ?? [];
    list.push({ value, labels, at: Date.now() });
    this.samples.set(name, list);
    this._evaluate(name, value, labels);
  }

  increment(name, by = 1, labels = {}) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
    this._evaluate(name, this.counters.get(name), labels);
  }

  percentile(name, p = 0.95) {
    const list = (this.samples.get(name) ?? []).map((sample) => sample.value).sort((a, b) => a - b);
    if (list.length === 0) return null;
    return list[Math.min(list.length - 1, Math.floor(list.length * p))];
  }

  count(name) {
    return this.counters.get(name) ?? 0;
  }

  _evaluate(name, value, labels) {
    const { epochDurationS, sourceFinalityDelayS } = this.config;
    if (name === "gate_lag_seconds") {
      const target = TARGETS.gate_lag_seconds.target(sourceFinalityDelayS);
      if (value > target * 2) this._alert("page", name, value, `gate lag ${value}s exceeds 2x target ${target}s`, labels);
      else if (value > target) this._alert("warn", name, value, `gate lag ${value}s above target ${target}s`, labels);
    }
    if (name === "epoch_clear_seconds") {
      const target = TARGETS.epoch_clear_seconds.target(sourceFinalityDelayS, epochDurationS);
      if (value > target) this._alert("page", name, value, `epoch clear ${value}s above target ${target}s`, labels);
    }
    if (name === "indexer_lag_blocks") {
      if (value > TARGETS.indexer_lag_blocks.pageAt) this._alert("page", name, value, "indexer far behind head", labels);
      else if (value > TARGETS.indexer_lag_blocks.warnAt) this._alert("warn", name, value, "indexer lagging", labels);
    }
    if (name === "room_fanout_lag_ms" && value > TARGETS.room_fanout_lag_ms.warnAt) {
      this._alert("warn", name, value, "fanout lag high", labels);
    }
    if (name === "slot_call_skipped") {
      // A persistently skipped market will refund its audience rather than settle.
      this._alert("page", name, value, `slot call skipped: ${labels.market ?? "unknown"}`, labels);
    }
    if (name === "refunds_from_missed_clearance" && value > 0) {
      this._alert("page", name, value, "actions refunded because clearance was missed", labels);
    }
    if (name === "missed_watermark") {
      this._alert("page", name, value, "an epoch passed with no watermark", labels);
    }
    if (name === "resolver_divergence") {
      this._alert("page", name, value, "resolver reconstruction diverged — market will fail closed", labels);
    }
    // Stream health warns; it is never paged as a market incident.
    if (name === "stream_unhealthy") this._alert("warn", name, value, "livestream degraded or unavailable", labels);
  }

  _alert(severity, metric, value, message, labels) {
    this.alerts.push({ severity, metric, value, message, labels, at: Date.now() });
  }

  pages() {
    return this.alerts.filter((alert) => alert.severity === "page");
  }

  warnings() {
    return this.alerts.filter((alert) => alert.severity === "warn");
  }

  /** Snapshot for /v1/health and dashboards. */
  report() {
    return {
      gate_lag_p95: this.percentile("gate_lag_seconds"),
      epoch_clear_p95: this.percentile("epoch_clear_seconds"),
      indexer_lag: this.percentile("indexer_lag_blocks", 1),
      fanout_lag_p95: this.percentile("room_fanout_lag_ms"),
      watermarks: this.count("watermark"),
      skips: this.count("slot_call_skipped"),
      refunds: this.count("refunds_from_missed_clearance"),
      pages: this.pages().length,
      warnings: this.warnings().length,
    };
  }
}
