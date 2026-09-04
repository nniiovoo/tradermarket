// The operator runtimes: Gate, Publisher, Connector, Resolver.
//
// The Coordinator holds no chain key — that is the point of it. Each of these
// holds a *different* one, which is why they are separate processes rather than
// threads of the same server: a compromise of the read surface must not be a
// compromise of the authority to sign a permit, publish a market, or attest a
// result. They share a chain and a durable store, and nothing else.
//
// Until now they were assembled only inside the game-day runner, which meant
// the tested composition and the operable one were different things. This is
// the operable one, and the game day exercises the same modules.
//
// Every role refuses to start without exactly what it needs. In particular each
// requires a durable store, because every one of them writes state whose loss
// is not a gap but a repetition: a connector that forgets re-signs facts it has
// already signed, and a gate that forgets re-issues permits it has already
// issued.

import { createPublicClient, http } from "viem";
import { Pool } from "pg";
import { toFunctionSelector } from "viem";

import { GateAuthority } from "./gate/authority.mjs";
import { PermitServer } from "./gate/permit-server.mjs";
import { KeeperService } from "./keeper/keeper.mjs";
import { firstTemplateCatalog } from "./publisher/publisher.mjs";
import { QueuedPublisher } from "./publisher/queue.mjs";
import { ResolverNode } from "./resolver/resolver.mjs";
import { ResolutionService } from "./resolver/resolution.mjs";
import { SourceConnector, makeSignatureVerifier } from "./connector/connector.mjs";
import { HyperliquidPoller, HYPERLIQUID_TESTNET_INFO_URL } from "./connector/hyperliquid.mjs";
import { Metrics, REPORTED_LATENCIES } from "./observability/metrics.mjs";
import { OnChainRoom } from "./ports/chain-viem.mjs";
import {
  openDatabase,
  SqliteEventStore,
  SqliteKeyValue,
  SqliteRawArchive,
  SqliteResolutionLog,
} from "./ports/sqlite-stores.mjs";
import { SqlitePublicationQueue } from "./ports/publication-queue.mjs";
import {
  redactedDatabaseUrl,
  migrate as migratePostgres,
  PostgresEventStore,
  PostgresKeyValue,
  PostgresPublicationQueue,
  PostgresRawArchive,
  PostgresResolutionLog,
} from "./ports/postgres-stores.mjs";
import { createSigner, selectorsFor } from "./ports/signer.mjs";
import { LIVE_ROOM_ABI, MARKET_ABI } from "./ports/chain-viem.mjs";

// The keeper is the fifth, and the only one that is not an authority: it
// decides nothing, and every function it may call is permissionless. It exists
// because every payout path on the market contract is `onlyFinal` and, until
// it was added, no production process ever called the three functions that make
// a market final. See src/keeper/keeper.mjs.
export const OPERATOR_ROLES = ["connector", "gate", "publisher", "resolver", "keeper"];

/** Which environment variable carries each role's signing key. */
const KEY_VAR = {
  connector: "TM_CONNECTOR_KEY",
  gate: "TM_GATE_KEY",
  publisher: "TM_PUBLISHER_KEY",
  resolver: "TM_RESOLVER_KEY",
  keeper: "TM_KEEPER_KEY",
};

/**
 * Records whether one tick of an operator's work actually succeeded.
 *
 * Each authority runs as its own process, catches its own errors and keeps
 * ticking — which is right, since exiting on a bad RPC response would stop a
 * live session over a blip. The cost is that a process which can never work
 * fails silently and forever, and nothing outside it can tell. This writes the
 * fact to the shared durable state, where the Coordinator reads it and exports
 * it, so a dead authority is something an operator is told about rather than
 * something they infer from a session that stopped moving.
 *
 * The error is stored as a single line. A stack trace in a database column is
 * not a diagnosis, and this one gets read back out through a metrics endpoint.
 */
export async function recordTick(state, role, { ok, error = null, nowMs = Date.now(), latencies = null }) {
  await state.set(`operator:${role}:last_tick_ms`, nowMs);
  // Latencies travel the same way liveness does, because they have the same
  // problem: the process that measures them holds no HTTP surface, and the
  // process that exports /metrics holds no key. The durable store is the only
  // thing both touch. Written on every tick that has a value, so a stale
  // number is distinguishable from a missing one by the tick timestamp beside
  // it rather than by guesswork.
  if (latencies) {
    for (const [metric, value] of Object.entries(latencies)) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
      await state.set(`operator:${role}:latency:${metric}`, Number(value));
    }
  }
  if (ok) {
    await state.set(`operator:${role}:last_success_ms`, nowMs);
    await state.set(`operator:${role}:last_error`, "");
    return;
  }
  const message = String(error?.shortMessage ?? error?.message ?? error ?? "unknown failure").split("\n")[0].trim();
  await state.set(`operator:${role}:last_error`, message.slice(0, 300));
}

/**
 * What the operator processes have reported about themselves.
 *
 * A role nobody has heard from is omitted rather than reported healthy or
 * failing: "no operator has ever written here" and "the operator is fine" are
 * different facts, and a deployment that never started its gate must not read
 * as one whose gate is working.
 */
export async function operatorHealth(state, roles = OPERATOR_ROLES, nowMs = Date.now()) {
  const health = [];
  for (const role of roles) {
    const lastTick = await state.get(`operator:${role}:last_tick_ms`, null);
    if (lastTick === null) continue;
    const lastSuccess = await state.get(`operator:${role}:last_success_ms`, null);
    const lastError = await state.get(`operator:${role}:last_error`, "") || null;
    const latencies = {};
    for (const metric of REPORTED_LATENCIES) {
      const value = await state.get(`operator:${role}:latency:${metric}`, null);
      if (value !== null) latencies[metric] = Number(value);
    }
    health.push({
      role,
      last_success_age_s: lastSuccess === null ? null : Math.floor((nowMs - Number(lastSuccess)) / 1000),
      failing: Boolean(lastError),
      last_error: lastError,
      latencies,
    });
  }
  return health;
}

/** Parses `alice=0x…,bob=0x…` into the participant list the source is read for. */
function parseParticipants(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, address] = entry.split("=").map((part) => part.trim());
      return { key, address };
    })
    .filter((entry) => entry.key && entry.address);
}

export function operatorConfigFromEnv(env = process.env) {
  return {
    roomId: env.TM_ROOM_ID ?? null,
    rpcUrl: env.TM_RPC_URL ?? null,
    factory: env.TM_FACTORY_ADDRESS ?? null,
    roomAddress: env.TM_ROOM_ADDRESS ?? null,
    chainId: env.TM_CHAIN_ID ? Number(env.TM_CHAIN_ID) : null,
    dataDir: env.TM_DATA_DIR ?? null,
    // The same backend selection the Coordinator has had since Phase 1 item 3.
    // Without it every role opened its own local SQLite file while the read
    // tier read PostgreSQL — so the publisher's condition documents and every
    // authority's liveness record went somewhere nothing else looked.
    databaseUrl: env.TM_DATABASE_URL ?? null,
    source: env.TM_SOURCE ?? null,
    sourceInfoUrl: env.TM_SOURCE_INFO_URL ?? null,
    // How often the incremental window is re-swept for restatements of fills it
    // has already passed. A provider that corrects an older figure is invisible
    // to a forward-only cursor.
    reconcileEveryMs: env.TM_RECONCILE_EVERY_MS ? Number(env.TM_RECONCILE_EVERY_MS) : 60_000,
    participants: parseParticipants(env.TM_PARTICIPANTS),
    // Who is expected to have signed the Session Event Log. A resolver checks
    // every event against this before attesting from it.
    //
    // Configured rather than read from chain because the room does NOT name the
    // connector — `LiveRoom` carries gateSigner, publisher, integrityAdjudicator
    // and the participants, and no source signer. So this is an out-of-band
    // fact, and the signature check is only as strong as it being right. That is
    // a real limitation, recorded in issue 48 rather than papered over.
    connectorAddress: env.TM_CONNECTOR_ADDRESS ?? null,
    pollMs: env.TM_OPERATOR_POLL_MS ? Number(env.TM_OPERATOR_POLL_MS) : 5000,
    epochDurationS: Number(env.TM_EPOCH_DURATION_S ?? 60),
    sourceFinalityDelayS: Number(env.TM_SOURCE_FINALITY_DELAY_S ?? 15),
    freshnessThresholdMs: Number(env.TM_FRESHNESS_THRESHOLD_MS ?? 20_000),
    maxPendingTimeS: Number(env.TM_MAX_PENDING_TIME_S ?? 900),
    announceDelayS: Number(env.TM_ANNOUNCE_DELAY_S ?? 30),
    keys: Object.fromEntries(Object.entries(KEY_VAR).map(([role, name]) => [role, env[name] ?? null])),
    env,
  };
}

function require(config, missing, field, name, why) {
  if (!config[field]) missing.push(`${name} (${why})`);
}

/**
 * Builds one operator. Throws, by design, when its configuration is incomplete:
 * an authority that starts half-configured is worse than one that does not
 * start, because the room waits for it either way and only one of those says so.
 */
/**
 * Source adapters this build can actually read.
 *
 * Named rather than open: an operator configured for a source nobody wrote an
 * adapter for would hold a key, a log and a schedule, and ingest nothing — and
 * a room waiting on facts that never arrive looks exactly like a quiet market.
 */
const SOURCE_ADAPTERS = {
  "hyperliquid-testnet": ({ connector, participants, infoUrl, fetchImpl, now, cursors }) =>
    new HyperliquidPoller({
      connector,
      participants,
      infoUrl: infoUrl ?? HYPERLIQUID_TESTNET_INFO_URL,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(now ? { now } : {}),
      cursors,
    }),
};

export function buildOperator(role, config, { publicClient = null, fetchImpl = null, now = null, pgClient: injectedPgClient = null } = {}) {
  if (!OPERATOR_ROLES.includes(role)) throw new Error(`unknown operator role "${role}"`);

  const missing = [];
  require(config, missing, "rpcUrl", "TM_RPC_URL", "the JSON-RPC endpoint");
  require(config, missing, "roomAddress", "TM_ROOM_ADDRESS", "the deployed LiveRoom address");
  require(config, missing, "roomId", "TM_ROOM_ID", "the room this operator serves");
  if (!config.keys[role]) {
    missing.push(`${KEY_VAR[role]} (this operator's own signing key — it signs nothing without one)`);
  }
  // Checked eagerly and never echoed raw: TM_DATABASE_URL carries a password,
  // and a startup error is exactly the kind of message that reaches a log.
  if (config.databaseUrl && !injectedPgClient && !redactedDatabaseUrl(config.databaseUrl)) {
    throw new Error(
      `The ${role} cannot start: TM_DATABASE_URL must be a postgres:// or postgresql:// connection string.`
    );
  }
  // Only when there is no database to hold it instead.
  if (!config.dataDir && !config.databaseUrl && !injectedPgClient) {
    missing.push(
      "TM_DATA_DIR or TM_DATABASE_URL (durable state — an operator that forgets does not skip work, it repeats it: re-signing facts and re-issuing permits)"
    );
  }
  if (role === "connector") {
    if (!config.source) missing.push("TM_SOURCE (which approved source this connector reads)");
    if (config.participants.length === 0) {
      missing.push("TM_PARTICIPANTS (the participants and addresses it is reading, as key=address pairs)");
    }
    if (config.source && !SOURCE_ADAPTERS[config.source]) {
      missing.push(
        `a source adapter for "${config.source}" (this build reads: ${Object.keys(SOURCE_ADAPTERS).join(", ")})`
      );
    }
  }
  if (role === "resolver" && config.participants.length === 0) {
    missing.push("TM_PARTICIPANTS (a resolver maps source facts to outcomes and cannot guess the mapping)");
  }
  if (role === "publisher" && config.participants.length === 0) {
    // Newly required. The publisher validates a question's participant against
    // the roster before it is ever signed, and without one that check silently
    // does nothing — which is how a mistyped participant used to reach the
    // chain and settle NO against somebody who was never in the room.
    missing.push("TM_PARTICIPANTS (the roster a question's participant is checked against before publication)");
  }
  if (missing.length > 0) {
    throw new Error(`The ${role} cannot start: ${missing.join(", ")} is not configured.`);
  }

  // Every authority signs through the port, never through viem directly. The
  // allow-list is computed from the ABI this build compiled against, so a
  // renamed function fails at startup rather than dropping silently out of the
  // permitted set — a tightened guard quietly becoming an open one is the
  // failure mode worth engineering against here.
  const account = createSigner({
    role,
    privateKey: config.keys[role],
    allowedSelectors: selectorsFor(role, [...LIVE_ROOM_ABI, ...MARKET_ABI], { toSelector: toFunctionSelector }),
  });
  // One chain definition for both clients.
  //
  // A wallet client signs the chain id it was GIVEN, not the one its RPC is
  // on, and the chain port used to default to foundry's 31337. Every write
  // from every operator on any other network was therefore signed for the
  // wrong chain and rejected by the node — a total failure that reads from
  // outside like a broken RPC rather than a misconfiguration.
  const chainDefinition = chainFor(config);
  const client =
    publicClient ??
    createPublicClient({
      transport: http(config.rpcUrl),
      ...(chainDefinition ? { chain: chainDefinition } : {}),
    });

  // One backend, never both — mirroring `durableStoreFor` in app.mjs.
  const pgClient = injectedPgClient ?? (config.databaseUrl ? new Pool({ connectionString: config.databaseUrl }) : null);
  const database = pgClient ? null : openDatabase(`${config.dataDir}/room.db`);
  const storeFor = (SqliteClass, PostgresClass, ...args) =>
    pgClient ? new PostgresClass(pgClient, ...args) : new SqliteClass(database, ...args);
  // Every authority serves one configured room. Its source sequence and
  // evidence window must not include facts written by another room sharing
  // the same durable database.
  const eventLog = storeFor(SqliteEventStore, PostgresEventStore).forRoom(config.roomId);
  const rawArchive = storeFor(SqliteRawArchive, PostgresRawArchive);
  const durableState = storeFor(SqliteKeyValue, PostgresKeyValue);

  // The publication channel between the gate and the publisher: two processes
  // holding two different keys need somewhere to hand work to each other that
  // outlives a restart of either.
  const queue = storeFor(SqlitePublicationQueue, PostgresPublicationQueue, config.roomId);

  const base = {
    role,
    address: account.address,
    config,
    client,
    database,
    pgClient,
    /**
     * Applies the schema, once, before the first tick. Async, and construction
     * is not — same reason `app.mjs` migrates in `start()`. A no-op on SQLite,
     * which migrates itself on open.
     */
    async migrate() {
      if (pgClient) await migratePostgres(pgClient);
    },
    /** Closes whichever backend this operator actually opened. */
    async close() {
      database?.close?.();
      // A real Pool exposes end(); PGlite, injected in tests, exposes close().
      if (pgClient) await (pgClient.end ? pgClient.end() : pgClient.close());
    },
    eventLog,
    rawArchive,
    durableState,
    queue,
    /** Credential-safe: an operator's key must never reach a log. */
    report() {
      return {
        role,
        address: account.address,
        room_id: config.roomId,
        room: config.roomAddress,
        chain_id: config.chainId,
        data_dir: config.dataDir,
        // Where this role's durable state actually lives — never the raw URL,
        // which carries a password.
        state_location: pgClient
          ? redactedDatabaseUrl(config.databaseUrl) ?? "PostgreSQL (connection injected directly)"
          : `${config.dataDir}/room.db`,
      };
    },
  };

  if (role === "connector") {
    const connector = new SourceConnector({
      roomId: config.roomId,
      source: config.source,
      store: eventLog,
      rawArchive,
      signer: account,
      clock: () => new Date().toISOString(),
    });
    return {
      ...base,
      participants: config.participants,
      connector,
      // The adapter that actually reads the source. Cursors are durable, so a
      // restart resumes its window rather than re-reading a whole session to
      // learn nothing.
      poller: SOURCE_ADAPTERS[config.source]({
        connector,
        participants: config.participants,
        infoUrl: config.sourceInfoUrl,
        fetchImpl,
        now,
        cursors: durableState,
      }),
    };
  }

  if (role === "resolver") {
    // Deliberately given no projection store: a resolver reconstructs the
    // result from raw provider bytes, and reading connector-derived scores or
    // Coordinator state would make its "independent" reconstruction a copy.
    //
    // It does get a chain port, with its OWN key. A resolver built with
    // `signerChain: null` was a process that held a resolver key, counted its
    // own incidents, and could not attest anything — the one thing only it can
    // do. The port is also how it discovers WHICH markets have closed, which
    // it must read from the chain rather than be told by the Coordinator.
    const resolverChain = new OnChainRoom({
      publicClient: client,
      rpc: config.rpcUrl,
      room: config.roomAddress,
      account,
      ...(chainDefinition ? { chain: chainDefinition } : {}),
    });
    const resolver = new ResolverNode({
      name: `resolver:${account.address.slice(0, 10)}`,
      rawArchive,
      participants: config.participants,
      signerChain: resolverChain,
    });
    return {
      ...base,
      chain: resolverChain,
      participants: config.participants,
      resolver,
      resolutionLog: storeFor(SqliteResolutionLog, PostgresResolutionLog, config.roomId, account.address),
      resolution: new ResolutionService({
        resolver,
        chain: resolverChain,
        queue,
        log: storeFor(SqliteResolutionLog, PostgresResolutionLog, config.roomId, account.address),
        eventLog,
        participants: config.participants,
        // Without TM_CONNECTOR_ADDRESS the structural checks still run — a gap,
        // a broken link or a hash mismatch needs no key — but nothing proves
        // WHO wrote the log.
        verifySignature: config.connectorAddress ? makeSignatureVerifier(config.connectorAddress) : null,
      }),
    };
  }

  const chain = new OnChainRoom({
    publicClient: client,
    rpc: config.rpcUrl,
    room: config.roomAddress,
    account,
    ...(chainDefinition ? { chain: chainDefinition } : {}),
  });

  // The keeper: no projection, no event log, no conditions, no permits. It
  // reads settlement state from the chain and calls whichever permissionless
  // finalization the contract would already accept. Chain time, not wall clock
  // — the contract compares against `block.timestamp`, and a keeper on its own
  // clock would send transactions that revert whenever the two drift.
  if (role === "keeper") {
    return {
      ...base,
      chain,
      keeper: new KeeperService({
        chain,
        chainNow: async () => Number((await client.getBlock()).timestamp),
      }),
    };
  }

  // The publisher gets a chain port and a queue and NOTHING ELSE. It used to
  // construct a GateAuthority here, signed with its own key, which made the
  // permit an attestation by the publisher that the publisher was happy — the
  // entire two-key design collapsed into a naming convention. It now asks the
  // gate process through the durable queue and waits, like any other caller.
  if (role === "publisher") {
    return {
      ...base,
      chain,
      publisher: new QueuedPublisher({
        chain,
        queue,
        // The roster, so a question naming somebody who is not in this room is
        // refused here rather than settling NO against them at session end.
        catalog: firstTemplateCatalog({ participants: config.participants }),
        config: { minAnnounceDelay: config.announceDelayS },
      }),
    };
  }

  // Built before the gate, because the gate needs it. It used to be created
  // afterwards and attached only to the returned object, so the process held a
  // metrics collector that nothing could write to and the gate had no way to
  // report the one latency the runbook pages on.
  const metrics = new Metrics({
    config: { epochDurationS: config.epochDurationS, sourceFinalityDelayS: config.sourceFinalityDelayS },
  });

  const gate = new GateAuthority({
    roomAddress: config.roomAddress,
    chainId: config.chainId,
    chain,
    store: eventLog,
    signer: account,
    conditions: new Map(),
    state: durableState,
    metrics,
    // The gate does not trust the publisher: with the catalogue it renders the
    // question itself and refuses a permit whose words disagree with the rule.
    catalog: firstTemplateCatalog({ participants: config.participants }),
    config: {
      participants: config.participants,
      epochDurationS: config.epochDurationS,
      sourceFinalityDelayS: config.sourceFinalityDelayS,
      freshnessThresholdMs: config.freshnessThresholdMs,
      maxPermitLifetimeS: 300,
      maxPendingTimeS: config.maxPendingTimeS,
      unevaluableGraceMs: 60_000,
      chainNow: async () => Number((await client.getBlock()).timestamp),
      headlineMarket: null,
    },
  });

  return {
    ...base,
    chain,
    gate,
    // The gate's other half: something other processes can ASK. Without it the
    // gate could decide whether a question was still open and had no way to be
    // asked the question.
    permitServer: new PermitServer({ gate, queue }),
    metrics,
  };
}

/**
 * Whether this operator's key holds the role the ROOM recognises.
 *
 * Each authority is named once, in the room's configuration, and the contract
 * refuses every other caller. A process started with the wrong key does not
 * fail visibly: the publisher validates a question, asks the gate for a permit,
 * burns it on a transaction the room was always going to refuse, and does that
 * once per request forever. From outside, a room publishing nothing because its
 * publisher key is wrong and one publishing nothing because nobody queued a
 * question look identical.
 *
 * Returns the problem as a sentence, or null when there is nothing to say.
 * An unreadable chain is NOT a problem: it says nothing about whether this key
 * holds the role, and refusing to start on it turns an RPC blip into an outage.
 *
 * @returns {Promise<string|null>}
 */
export async function verifyOperatorAuthority(operator) {
  const expected = {
    gate: ["gateSigner", "Source Gate Authority"],
    publisher: ["publisherAddress", "Program Publisher"],
  }[operator.role];
  // The connector signs the event log, not the chain, and a resolver's role
  // lives on each market rather than on the room — and no market exists when
  // it starts. Neither can be checked here; the resolver's refusals cover it.
  if (!expected || !operator.chain) return null;

  const [method, title] = expected;
  let onChain;
  try {
    onChain = await operator.chain[method]();
  } catch {
    return null;
  }
  if (!onChain) return null;
  if (String(onChain).toLowerCase() === String(operator.address).toLowerCase()) return null;
  return (
    `This process holds ${operator.address}, but the room at ${operator.config.roomAddress} names ` +
    `${onChain} as its ${title}. Every transaction it sends would be refused.`
  );
}

/**
 * The viem chain for a configured deployment.
 *
 * Minimal on purpose: an id and an RPC are everything a signer needs, and
 * pulling a named chain from viem's registry would mean a deployment on a
 * network the registry has not heard of could not be configured at all.
 */
export function chainFor(config) {
  if (!config.chainId) return null;
  return {
    id: Number(config.chainId),
    name: config.chainName ?? `chain-${config.chainId}`,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  };
}
