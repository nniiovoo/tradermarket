// Metrics an operator can actually scrape.
//
// The metrics module existed and was exercised only inside the game-day runner,
// so a running deployment produced no signal at all: nobody could know the
// indexer had stalled, the source had gone stale, or the stream had dropped,
// short of reading the page and guessing.
//
// Prometheus text exposition because it needs no credential, no vendor and no
// account — anything that scrapes HTTP can read it, and an operator who prefers
// something else can point their own agent at the same endpoint. That is what
// makes monitoring something this repo can finish rather than describe.
//
// The one rule here is the same as everywhere else: a number nobody measured is
// omitted, never exported as zero. A chain head of 0 reads as "the chain is at
// genesis", and an alert on the lag derived from it would page someone about a
// stall that is not happening.

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const INDEXER_STATES = ["current", "delayed", "unknown"];
const STREAM_STATES = ["live", "degraded", "unavailable", "unknown"];
const SOURCE_STATES = ["fresh", "stale", "unknown"];

import { REPORTED_LATENCIES } from "./metrics.mjs";

function gauge(lines, name, help, value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return;
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${Number(value)}`);
}

/** One series per state, so an alert rule never parses a label out of a string. */
function stateGauge(lines, name, help, states, actual) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const state of states) lines.push(`${name}{state="${state}"} ${state === actual ? 1 : 0}`);
}

export function renderMetrics(snapshot = {}) {
  const lines = [];
  const {
    room_ids = [],
    chain_head = null,
    indexer_cursor = null,
    indexer_health = "unknown",
    stream_health = "unknown",
    source_health = "unknown",
    rooms_indexed = null,
    reorgs_seen = null,
    epoch_clear_seconds = null,
    markets_indexed = null,
    chat_messages = null,
    non_chain_history_durable = null,
    config_warning = null,
    operators = [],
    durable_bytes = null,
    // Measured at app.mjs:679-680 and, until now, dropped right here: this
    // destructure is a fixed field list, so a standby was indistinguishable
    // from a leader on /metrics as well as on /v1/health.
    leading = null,
    replica_id = null,
  } = snapshot;

  gauge(lines, "tradermarket_rooms_served", "Rooms this process serves.", room_ids.length);
  gauge(lines, "tradermarket_chain_head", "Highest block this process has seen on chain.", chain_head);
  gauge(lines, "tradermarket_indexer_cursor", "Highest block the indexer has applied.", indexer_cursor);

  // Derived only where both sides are real.
  if (chain_head !== null && chain_head !== undefined && indexer_cursor !== null && indexer_cursor !== undefined) {
    gauge(
      lines,
      "tradermarket_indexer_lag_blocks",
      "Blocks between the chain head and the indexer cursor.",
      Number(chain_head) - Number(indexer_cursor)
    );
  }

  gauge(
    lines,
    "tradermarket_reorgs_seen",
    "Chain reorganisations this process has detected and rolled back through.",
    reorgs_seen
  );
  gauge(
    lines,
    "tradermarket_epoch_clear_seconds",
    "Slowest recent delay between a forecaster action being submitted and executed.",
    epoch_clear_seconds
  );
  gauge(lines, "tradermarket_rooms_indexed", "Rooms present in the projections.", rooms_indexed);
  gauge(lines, "tradermarket_markets_indexed", "Markets present in the projections.", markets_indexed);
  gauge(lines, "tradermarket_chat_messages", "Chat messages retained across served rooms.", chat_messages);
  gauge(
    lines,
    "tradermarket_durable_bytes",
    "Bytes of non-chain history on disk. Never pruned: this is the settlement evidence.",
    durable_bytes
  );

  if (non_chain_history_durable !== null && non_chain_history_durable !== undefined) {
    gauge(
      lines,
      "tradermarket_history_durable",
      "1 when non-chain history survives a restart, 0 when it is held in memory.",
      non_chain_history_durable ? 1 : 0
    );
  }

  gauge(
    lines,
    "tradermarket_config_warning",
    "1 when this process can see that it is misconfigured.",
    config_warning ? 1 : 0
  );

  // One series per role that has actually reported. A role nobody has heard
  // from is absent here: exporting a zero age for a gate that never started
  // would read as the healthiest possible gate.
  if (operators.length > 0) {
    lines.push(
      "# HELP tradermarket_operator_last_success_age_seconds Seconds since this authority last completed a tick.",
      "# TYPE tradermarket_operator_last_success_age_seconds gauge"
    );
    for (const entry of operators) {
      if (entry.last_success_age_s === null || entry.last_success_age_s === undefined) continue;
      lines.push(`tradermarket_operator_last_success_age_seconds{role="${entry.role}"} ${Number(entry.last_success_age_s)}`);
    }
    // Latencies the authorities measured and wrote to the shared store.
    //
    // The metric is DECLARED unconditionally and its series emitted only where
    // a real measurement exists. Both halves matter. Declaring it always is
    // what makes it discoverable and lets an alert rule reference it before the
    // first sample arrives — a rule naming a metric that appears only after the
    // fact is a rule nobody can validate. Emitting a series only for a real
    // measurement is what keeps it honest: a gauge defaulted to zero for an
    // authority that has never measured anything reads as a perfectly fast
    // gate, which is the opposite of the truth.
    for (const metric of REPORTED_LATENCIES) {
      lines.push(
        `# HELP tradermarket_${metric} Latency reported by the authority that measured it.`,
        `# TYPE tradermarket_${metric} gauge`
      );
      for (const entry of operators) {
        const value = entry.latencies?.[metric];
        if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
        lines.push(`tradermarket_${metric}{role="${entry.role}"} ${Number(value)}`);
      }
    }
    lines.push(
      "# HELP tradermarket_operator_failing 1 when this authority's last tick failed.",
      "# TYPE tradermarket_operator_failing gauge"
    );
    for (const entry of operators) {
      lines.push(`tradermarket_operator_failing{role="${entry.role}"} ${entry.failing ? 1 : 0}`);
    }
  }

  stateGauge(lines, "tradermarket_indexer_health", "Indexer health, one series per state.", INDEXER_STATES, indexer_health);
  stateGauge(lines, "tradermarket_stream_health", "Livestream health, one series per state.", STREAM_STATES, stream_health);

  // Which replica this is, and whether it is currently indexing anything. A
  // load balancer round-robining two replicas sends half its viewers to a
  // standby serving state `draft`, zero slots and block 0 — plausible-looking
  // and empty — and without this there is nothing to drain on.
  if (leading !== null) {
    gauge(lines, "tradermarket_leading", "1 when this replica currently leads at least one room.", leading ? 1 : 0);
  }
  if (replica_id !== null) {
    lines.push("# HELP tradermarket_replica Replica identity, as a label on a constant.");
    lines.push("# TYPE tradermarket_replica gauge");
    lines.push(`tradermarket_replica{replica_id="${String(replica_id).replace(/"/g, "")}"} 1`);
  }
  stateGauge(lines, "tradermarket_source_health", "Approved-source freshness, one series per state.", SOURCE_STATES, source_health);

  return `${lines.join("\n")}\n`;
}
