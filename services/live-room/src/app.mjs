// Composition root for the Live Room Coordinator process.
//
// This is the one place that turns configuration into a running service. It has
// a single hard rule: a process that is not configured does not start. There is
// no fallback mode, no demo room, no seeded projection. A website pointed at
// this API is entitled to assume that everything it reads came off a chain, and
// the only way to keep that promise is to refuse to run without one.
//
// The Coordinator holds no chain key. Nothing assembled here can submit a
// transaction, hold collateral, publish a market, or choose a result.

import { readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPublicClient, decodeFunctionData, http, parseAbi } from "viem";

import { RoomApiServer } from "./api/server.mjs";
import { Allowlist } from "./api/allowlist.mjs";
import { LiveRoomCoordinator } from "./coordinator/coordinator.mjs";
import { Capabilities, paymasterFromEnv } from "./config/capabilities.mjs";
import { ActivityFeed } from "./discovery/activity.mjs";
import { Leaderboard } from "./discovery/leaderboard.mjs";
import { Portfolio } from "./discovery/portfolio.mjs";
import { Schedule } from "./discovery/schedule.mjs";
import { ChatService, PlaybackService, RealtimeEdge } from "./edge/edge.mjs";
import { EntryGate } from "./entry/entry.mjs";
import { Growth } from "./growth/growth.mjs";
import { HelpCenter } from "./help/help.mjs";
import { ViemLogSource, ViemMarketReader } from "./indexer/chain-source.mjs";
import { ChainIndexer } from "./indexer/indexer.mjs";
import { ProjectionStore } from "./indexer/projection.mjs";
import { createPaymaster } from "./paymaster/paymaster.mjs";
import { operatorHealth } from "./operators.mjs";
import { LivestreamOracle } from "./oracle/livestream-oracle.mjs";
import { StreamMonitor } from "./stream/monitor.mjs";
import { conditionHash } from "./domain/conditions.mjs";
import { MemoryEventStore, MemoryLeaderLease } from "./ports/stores.mjs";
import { SqlitePublicationQueue } from "./ports/publication-queue.mjs";
import {
  openDatabase,
  SqliteAcceptanceStore,
  SqliteChatStore,
  SqliteEventStore,
  SqliteKeyValue,
  SqliteLeaderLease,
  SqliteOracleProofStore,
  SqliteRawArchive,
  SqliteReferralStore,
} from "./ports/sqlite-stores.mjs";
import {
  redactedDatabaseUrl,
  migrate as migratePostgres,
  PostgresAcceptanceStore,
  PostgresChatStore,
  PostgresEventStore,
  PostgresKeyValue,
  PostgresLeaderLease,
  PostgresOracleProofStore,
  PostgresPublicationQueue,
  PostgresRawArchive,
  PostgresReferralStore,
} from "./ports/postgres-stores.mjs";
// Re-exported: it lives with the Postgres adapter now, but scripts import it
// from here and there is no reason to churn them.
export { redactedDatabaseUrl };
import { SettlementService } from "./settlement/settlement.mjs";

const REQUIRED = [
  ["rpcUrl", "TM_RPC_URL", "the JSON-RPC endpoint of the test network"],
  ["factory", "TM_FACTORY_ADDRESS", "the deployed LiveMarketFactory address"],
];

const DEPLOYMENT_NOTICE = "unaudited testnet software with no real-world value";
const CHALLENGE_CALL_ABI = parseAbi(["function challengeResult(bytes32 evidenceHash,uint256 bond)"]);

/** Proves a public counter-evidence reference belongs to a paid on-chain challenge. */
export async function verifyChallengeTransaction(client, { market, evidenceHash, transactionHash }) {
  try {
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: transactionHash }),
      client.getTransactionReceipt({ hash: transactionHash }),
    ]);
    if (
      receipt?.status !== "success"
      || String(transaction?.to ?? "").toLowerCase() !== String(market ?? "").toLowerCase()
    ) {
      return { verified: false, reason: "transaction is not a successful call to this market" };
    }
    const decoded = decodeFunctionData({ abi: CHALLENGE_CALL_ABI, data: transaction.input });
    if (
      decoded.functionName !== "challengeResult"
      || String(decoded.args?.[0] ?? "").toLowerCase() !== String(evidenceHash ?? "").toLowerCase()
    ) {
      return { verified: false, reason: "transaction does not register this challenge evidence hash" };
    }
    return { verified: true, challenger: transaction.from };
  } catch {
    return { verified: false, reason: "challenge transaction could not be verified on the configured chain" };
  }
}

/** Reads configuration from the environment. Absent values stay absent. */
/**
 * Reads a numeric setting, or refuses to start.
 *
 * `Number(env.X)` with no check was how every numeric setting was read, and a
 * typo produced NaN or a negative that the service happily started on. The
 * consequences are not cosmetic: a NaN chain id signs every transaction for a
 * chain that does not exist, and a NaN rate limit does not become large — every
 * `count > NaN` is false, so the limit stops existing.
 *
 * The error names the variable and echoes what it was given, because an
 * operator has to be able to fix it without reading this file. It never echoes
 * a value from a variable whose name marks it as a secret: startup errors reach
 * logs, and logs reach places keys must not.
 */
function numeric(env, name, fallback, { min = 1, allowNull = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return allowNull ? null : fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    const shown = /KEY|SECRET|TOKEN|PASSWORD/i.test(name) ? "<redacted>" : JSON.stringify(String(raw));
    throw new Error(
      `The Live Room Coordinator cannot start: ${name} must be a number of at least ${min}, but was ${shown}.`
    );
  }
  return value;
}


export function configFromEnv(env = process.env) {
  const list = (value) =>
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  // `TM_ROOMS=alpha=0x…,beta=0x…` serves several rooms from one process; the
  // single-room pair is the same thing with one entry.
  const rooms = list(env.TM_ROOMS)
    .map((entry) => {
      const [roomId, address] = entry.split("=").map((part) => part.trim());
      return { roomId, address };
    })
    .filter((entry) => entry.roomId && entry.address);
  if (rooms.length === 0 && env.TM_ROOM_ID && env.TM_ROOM_ADDRESS) {
    rooms.push({ roomId: env.TM_ROOM_ID, address: env.TM_ROOM_ADDRESS });
  }

  return {
    rooms,
    roomId: env.TM_ROOM_ID ?? null,
    rpcUrl: env.TM_RPC_URL ?? null,
    factory: env.TM_FACTORY_ADDRESS ?? null,
    // One factory usually creates every room, but a deployment can span more.
    factories: list(env.TM_FACTORIES).length > 0 ? list(env.TM_FACTORIES) : [env.TM_FACTORY_ADDRESS].filter(Boolean),
    roomAddress: env.TM_ROOM_ADDRESS ?? null,
    chainId: numeric(env, "TM_CHAIN_ID", null, { allowNull: true }),
    port: numeric(env, "TM_PORT", 8787),
    // Where the non-chain history lives. Projections rebuild from chain, so
    // they need no file; the Session Event Log, the raw provider bytes, chat
    // and its moderation, and the terms acceptances cannot be rebuilt from
    // anywhere and are only durable if this is set.
    dataDir: env.TM_DATA_DIR ?? null,
    // When set, structured non-chain history lives in PostgreSQL instead of
    // the local SQLite file — TM_DATA_DIR still matters for evidence
    // recordings either way, since object storage for those does not exist
    // yet. The connection string's own sslmode/query params carry whatever a
    // provider needs; nothing here assumes one.
    databaseUrl: env.TM_DATABASE_URL ?? null,
    pollMs: numeric(env, "TM_POLL_MS", 4000),
    // How often a quiet room says it is alive. Advertised to every client in
    // its `hello` frame AND used to drive the timer, from this one value —
    // a promised cadence nothing honours is worse than promising nothing.
    heartbeatMs: numeric(env, "TM_HEARTBEAT_MS", 10_000),
    streamPollMs: numeric(env, "TM_STREAM_POLL_MS", 6000),
    participantKeys: { a: env.TM_PARTICIPANT_A ?? null, b: env.TM_PARTICIPANT_B ?? null },
    chat: {
      enabled: env.TM_CHAT_ENABLED === "true",
      rateLimitPerMinute: numeric(env, "TM_CHAT_RATE_LIMIT", 10),
      slowModeMs: numeric(env, "TM_CHAT_SLOW_MODE_MS", 2000, { min: 0 }),
      moderators: list(env.TM_CHAT_MODERATORS),
    },
    allowlist: { enabled: env.TM_ALLOWLIST_ENABLED === "true", addresses: list(env.TM_ALLOWLIST) },
    env,
  };
}

/** Assembles the service. Throws, by design, when configuration is incomplete. */
export function buildService(
  config,
  { publicClient = null, verifySignature = null, fetchImpl = null, pgClient: injectedPgClient = null } = {}
) {
  const missing = REQUIRED.filter(([field]) => !config?.[field]).map(
    ([, name, why]) => `${name} (${why})`
  );
  if (!config?.rooms || config.rooms.length === 0) {
    missing.push(
      "TM_ROOMS as roomId=address pairs, or TM_ROOM_ID with TM_ROOM_ADDRESS (the rooms this process serves)"
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `The Live Room Coordinator cannot start: ${missing.join(", ")} is not configured. ` +
        "This process serves indexed chain facts only and has no fixture mode."
    );
  }
  // Checked eagerly and never echoed raw: a malformed value is common (a
  // pasted connection string missing its scheme) and a startup error is
  // exactly the kind of message that ends up in a log a password must not.
  if (config.databaseUrl && !injectedPgClient && !redactedDatabaseUrl(config.databaseUrl)) {
    throw new Error(
      "The Live Room Coordinator cannot start: TM_DATABASE_URL must be a postgres:// or postgresql:// " +
        "connection string."
    );
  }

  const client =
    publicClient ??
    createPublicClient({
      transport: http(config.rpcUrl),
      ...(config.chainId ? { chain: { id: config.chainId, name: "configured", nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } } } : {}),
    });

  const store = new ProjectionStore();

  // The projections above are deliberately in memory: they are disposable and
  // rebuild from chain logs. Everything below cannot be rebuilt from anywhere.
  //
  // PostgreSQL, when configured, replaces SQLite for all of it — never both.
  // A pool is constructed synchronously (it connects lazily; nothing over the
  // wire happens yet), but migrating it is async and this function is not, so
  // migration happens once in start(). A caller that uses a store before
  // start() has run needs to have supplied an already-migrated `pgClient`.
  const pgClient = injectedPgClient ?? (config.databaseUrl ? new Pool({ connectionString: config.databaseUrl }) : null);
  const database = !pgClient && config.dataDir ? openDatabase(`${config.dataDir}/room.db`) : null;
  const durable = Boolean(pgClient || database);

  /** One store, against whichever durable backend is configured; null with neither. */
  const durableStoreFor = (SqliteClass, PostgresClass, ...args) => {
    if (pgClient) return new PostgresClass(pgClient, ...args);
    if (database) return new SqliteClass(database, ...args);
    return null;
  };

  // A room's source sequence starts at one and is meaningful only inside that
  // room. Keep one shared durable backend, but hand every consumer a scoped
  // view so facts from another room can neither advance its cursor nor decide
  // its markets.
  const eventLogs = durableStoreFor(SqliteEventStore, PostgresEventStore) ?? new MemoryEventStore();
  const eventLogFor = (roomId) => eventLogs.forRoom(roomId);
  const rawArchive = durableStoreFor(SqliteRawArchive, PostgresRawArchive);
  const durableState = durableStoreFor(SqliteKeyValue, PostgresKeyValue);
  // In-memory falls back to its own trivial lease rather than skipping
  // leadership entirely: a process with no shared store is, by construction,
  // the only holder there could ever be, so it always wins it.
  const leaderLease = durableStoreFor(SqliteLeaderLease, PostgresLeaderLease) ?? new MemoryLeaderLease();
  const replicaId = randomUUID();
  // A few poll cycles long: long enough that one slow tick does not cost the
  // leader its lease, short enough that a genuinely dead leader is replaced
  // in a handful of polls rather than sitting stale for minutes.
  const leaseTtlMs = Math.max(config.pollMs * 4, 15_000);
  // Complete recordings still live on this process's disk either way — object
  // storage for them does not exist yet (Phase 1, unbuilt) — so the oracle
  // stays off without TM_DATA_DIR regardless of which backend holds the rest.
  const oracleStore = config.dataDir ? durableStoreFor(SqliteOracleProofStore, PostgresOracleProofStore) : null;
  const oracle = oracleStore
    ? new LivestreamOracle({ store: oracleStore, proofDir: `${config.dataDir}/oracle-proofs` })
    : null;
  const chatStore = durableStoreFor(SqliteChatStore, PostgresChatStore);
  const acceptances = durableStoreFor(SqliteAcceptanceStore, PostgresAcceptanceStore) ?? new Map();
  // The HTTP allowlist must be able to answer the very first gated request
  // after a restart. A lazy copy into an in-memory terms map only worked after
  // the visitor happened to load /entry/status first. Expose a narrow map-like
  // view that returns a terms version only when the durable signature proof is
  // present; an unsigned acceptance can never open the interface.
  const provenAcceptances = durable
    ? {
        async get(address) {
          if (!(await acceptances.proven(address))) return undefined;
          return acceptances.get(address);
        },
        async set(address, version) {
          return acceptances.set(address, version);
        },
      }
    : null;
  // Without a durable store there is nowhere to record a binding, so the
  // referral count stays at zero and says so rather than pretending.
  const referralStore = durableStoreFor(SqliteReferralStore, PostgresReferralStore);
  const publicationQueues = durable
    ? new Map(
        config.rooms.map((room) => [room.roomId, durableStoreFor(SqlitePublicationQueue, PostgresPublicationQueue, room.roomId)])
      )
    : new Map();

  // The required-field check above validates `factory`; everything below reads
  // `factories`. A caller that satisfies the stated contract still crashed on a
  // TypeError naming nothing, which is a poor answer from a function whose
  // whole job is to refuse an incomplete configuration clearly.
  const factories = config.factories?.length ? config.factories : [config.factory];

  /** Bytes on disk, including the write-ahead log, or null when in memory. */
  const durableBytes = () => {
    if (!config.dataDir) return null;
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += statSync(`${config.dataDir}/room.db${suffix}`).size;
      } catch {
        // A WAL that does not exist yet contributes nothing.
      }
    }
    try {
      for (const entry of readdirSync(`${config.dataDir}/oracle-proofs`, { withFileTypes: true })) {
        if (entry.isFile()) total += statSync(`${config.dataDir}/oracle-proofs/${entry.name}`).size;
      }
    } catch {
      // No evidence directory yet contributes nothing.
    }
    return total;
  };

  const logs = new ViemLogSource({
    publicClient: client,
    // Every factory and every room this process serves. Watching one while
    // serving several means the others' events are never fetched, and their
    // rooms stay permanently empty with no error to show for it.
    factory: factories.length > 1 ? factories : factories[0],
    rooms: () => config.rooms.map((room) => room.address),
    markets: () => [...store.markets.values()].map((row) => row.market_address),
  });
  const reader = new ViemMarketReader({ publicClient: client });
  const indexer = new ChainIndexer({ store, logs, reader });

  // One coordinator, edge and chat per room. They share the chain, the indexer
  // and the store — two rooms on one chain should not mean two sweeps of it —
  // but a room's frame sequence, its viewers and its conversation are its own,
  // and merging them would put one room's messages in another room's window.
  const roomRuntimes = new Map();
  for (const entry of config.rooms) {
    const edgeRef = {};
    const roomEventLog = eventLogFor(entry.roomId);
    const coordinator = new LiveRoomCoordinator({
      roomId: entry.roomId,
      store,
      eventLog: roomEventLog,
      publishTo: (frame) => edgeRef.edge?.broadcast(frame),
      config: { freshnessThresholdMs: 20_000, retention: 200, heartbeatMs: config.heartbeatMs },
    });
    edgeRef.edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: config.heartbeatMs, maxQueue: 256 } });
    roomRuntimes.set(entry.roomId, {
      roomId: entry.roomId,
      address: entry.address,
      coordinator,
      edge: edgeRef.edge,
      eventLog: roomEventLog,
      chat: null,
      streamMonitor: null,
    });
  }

  // The first room is what the single-room surfaces speak for.
  const primary = roomRuntimes.get(config.rooms[0].roomId);
  const coordinator = primary.coordinator;
  const edge = primary.edge;
  const eventLog = primary.eventLog;

  // Resolved here, ahead of the capabilities object below, because that
  // object reports on the PRIMARY room the same way `room.roomId` above
  // already does — and the primary room's actual playback URL may come from
  // either config shape. See streamMonitorFor further down for the full
  // per-room story this same helper drives.
  const streamPlaybackUrls = new Map(
    String(config.env?.TM_STREAM_PLAYBACK_URLS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.split("=").map((part) => part.trim()))
  );
  const streamPlaybackUrlFor = (roomId) =>
    streamPlaybackUrls.size > 0 ? streamPlaybackUrls.get(roomId) ?? null : config.env?.TM_STREAM_PLAYBACK_URL ?? null;

  const capabilities = new Capabilities({
    room: { apiUrl: config.env?.TM_ROOM_API_URL, roomId: config.rooms[0].roomId },
    stream: { playbackUrl: streamPlaybackUrlFor(config.rooms[0].roomId), provider: config.env?.TM_STREAM_PROVIDER },
    chat: { enabled: config.chat.enabled },
    paymaster: paymasterFromEnv(config.env ?? {}),
    // The capability follows the same condition the service applies, so the
    // report and the behaviour cannot disagree.
    settlement: { participantKeys: config.participantKeys },
    chain: { factory: config.factory, chainId: config.chainId },
    funding: { faucetUrl: config.env?.TM_FAUCET_URL },
    allowlist: { enabled: config.allowlist.enabled },
    referrals: {
      enabled: config.env?.TM_REFERRALS_ENABLED === "true",
      programId: config.env?.TM_REFERRAL_PROGRAM_ID,
    },
    socialProof: { enabled: config.env?.TM_SOCIAL_PROOF_ENABLED === "true" },
    community: { inviteUrl: config.env?.TM_COMMUNITY_URL },
    embeddedAccount: { provider: config.env?.TM_EMBEDDED_ACCOUNT_PROVIDER },
    oracle: {
      dataDir: config.dataDir,
      operatorTokenConfigured: Boolean(config.env?.TM_ORACLE_OPERATOR_TOKEN),
    },
  });

  // Chat identity is a wallet signature. Without a verifier the service cannot
  // tell who is speaking, so it declines every post rather than guessing.
  const chatFor = (roomId) =>
    new ChatService({
      verifySignature: verifySignature ?? (async () => false),
      config: {
        // The room the claims are bound to, so a signature made in one room
        // cannot post in another.
        roomId,
        rateLimitPerMinute: config.chat.rateLimitPerMinute,
        slowModeMs: config.chat.slowModeMs,
        moderators: new Set(config.chat.moderators.map((entry) => entry.toLowerCase())),
        labels: new Map(),
      },
      // Each room's conversation is its own table namespace in the shared file.
      store: chatStore ? chatStore.forRoom(roomId) : null,
    });

  for (const runtime of roomRuntimes.values()) runtime.chat = chatFor(runtime.roomId);
  const chat = primary.chat;

  // The stream is measured, not declared. Without a playback URL this polls
  // nothing and reports "unknown", which is the honest answer to a question
  // nobody asked the network.
  //
  // One monitor per room, mirroring chatFor above: a creator supplies their
  // OWN stream per room, and one shared monitor broadcast into every room's
  // coordinator would show every room the same LIVE badge regardless of
  // whether that room's own stream is the one actually live — exactly the
  // failure the per-room chat/edge split above already exists to prevent for
  // messages and frames, just not previously extended to stream health.
  // streamPlaybackUrlFor is resolved earlier, alongside `capabilities` — see
  // there for the "roomId=value" list format and the single-room fallback.
  const streamMonitorFor = (roomId) =>
    new StreamMonitor({
      playbackUrl: streamPlaybackUrlFor(roomId),
      degradedAfterMs: config.env?.TM_STREAM_DEGRADED_AFTER_MS
        ? Number(config.env.TM_STREAM_DEGRADED_AFTER_MS)
        : 12_000,
      fetchImpl,
    });
  for (const runtime of roomRuntimes.values()) runtime.streamMonitor = streamMonitorFor(runtime.roomId);
  // Single-room surfaces (the boot report, /metrics) speak for the primary
  // room, exactly as coordinator/edge/chat above already do.
  const streamMonitor = primary.streamMonitor;

  const playback = new PlaybackService({
    config: {
      degradedAfterMs: 10_000,
      disclosedDelayS: config.env?.TM_STREAM_DELAY_S ? Number(config.env.TM_STREAM_DELAY_S) : 0,
    },
  });

  const allowlist = new Allowlist({
    addresses: config.allowlist.addresses,
    enabled: config.allowlist.enabled,
    ...(provenAcceptances ? { terms: provenAcceptances } : {}),
  });

  // Settlement needs to know which source participant is Outcome A. Without
  // that mapping the records are omitted rather than guessed: guessing here
  // would mislabel who won.
  const settlement =
    config.participantKeys.a && config.participantKeys.b
      ? new SettlementService({
          store,
          eventLog,
          eventLogForRoom: eventLogFor,
          conditionForMarket: async (market, roomId, expectedHash) => {
            const record = await publicationQueues.get(roomId)?.conditionForMarket(market);
            const document = record?.conditionDocument ?? null;
            if (!document || !expectedHash) return null;
            // The queue is durable transport, not authority. A document is
            // shown and replayed only when it matches the immutable binding the
            // indexed slot carries from chain.
            try {
              if (
                String(conditionHash(document)).toLowerCase() !== String(expectedHash).toLowerCase()
              ) {
                return null;
              }
            } catch {
              return null;
            }
            return document;
          },
          conditions: new Map(),
          participantKeys: config.participantKeys,
          playback,
        })
      : null;

  const activity = new ActivityFeed({ store, settlement });
  const schedule = new Schedule({ store, roomIds: config.rooms.map((room) => room.roomId) });
  const leaderboard = new Leaderboard({ store });
  // The portfolio reads `lpFeeCredit` and `winnerFeePaid` per account: no log
  // carries them, so without this it could only guess at what is still owed.
  const portfolio = new Portfolio({ store, accountReader: reader });
  // The same verifier chat uses: a terms acceptance that carries a signature
  // is recorded as proven, and one that does not is recorded as self-declared.
  const entry = new EntryGate({ allowlist, capabilities, verifySignature, acceptances });
  const help = new HelpCenter();
  const growth = new Growth({ capabilities, store, referrals: referralStore, verifySignature });
  const paymaster = createPaymaster({ capabilities });

  const server = new RoomApiServer({
    coordinator,
    edge,
    chat,
    playback,
    store,
    eventLog,
    settlement,
    allowlist,
    capabilities,
    entry,
    help,
    activity,
    schedule,
    leaderboard,
    portfolio,
    growth,
    // Read lazily: the mismatch is only knowable once the room is indexed.
    configWarning: () => serviceRef.health?.().warning ?? null,
    rooms: roomRuntimes,
    metricsSnapshot: async () => (await serviceRef.metrics?.()) ?? {},
    // The authorities write their liveness into the same durable state this
    // process reads. Without a data directory there is nowhere for them to
    // have written, so the honest answer is an empty list rather than a
    // reassuring one.
    operators: async () => (durableState ? await operatorHealth(durableState) : []),
    // Read from the loop's own flag rather than acquiring a lease: a health
    // check must not renew or steal leadership just by being scraped.
    leading: async () => leading,
    oracle,
    oracleToken: config.env?.TM_ORACLE_OPERATOR_TOKEN ?? null,
    oracleChallengeVerifier: (claim) => verifyChallengeTransaction(client, claim),
  });

  // Set once the service object exists, so the server can read its health.
  const serviceRef = {};
  let timer = null;
  // The stream is polled on its own cadence: a chain that is behind must not
  // make the picture look down, and vice versa.
  let streamTimer = null;
  let heartbeatTimer = null;
  // A poll slower than the interval must not start a second pass on top of the
  // first: two passes sharing one cursor can advance it past blocks the other
  // has not applied, and the history that falls in the gap is lost silently.
  let syncing = null;
  // Set by syncOnce, the only place leadership is actually decided.
  // pollStream reads it rather than acquiring its own lease, both to avoid a
  // redundant durable-store round trip on every stream tick and so the two
  // loops can never disagree about who is leading.
  let leading = false;
  // Which rooms this replica actually holds, so a change in the set is logged
  // rather than only a change in "leads anything".
  let ledRooms = [];
  let warnedAboutRoom = false;
  // Counted so an operator can see reorg churn rather than infer it from logs.
  let reorgsSeen = 0;

  const service = {
    config,
    client,
    database,
    pgClient,
    rawArchive,
    durableState,
    leaderLease,
    replicaId,
    leaseTtlMs,
    oracle,
    streamMonitor,
    /** The rooms this process serves, and the runtime for each. */
    roomIds: [...roomRuntimes.keys()],
    roomFor: (roomId) => roomRuntimes.get(roomId) ?? null,
    store,
    eventLog,
    indexer,
    coordinator,
    edge,
    chat,
    playback,
    capabilities,
    allowlist,
    settlement,
    activity,
    schedule,
    leaderboard,
    portfolio,
    growth,
    entry,
    help,
    paymaster,
    server,

    /**
     * Whether the room this process serves is the room it was pointed at.
     *
     * An operator who sets TM_ROOM_ID to one room and TM_ROOM_ADDRESS to
     * another gets a permanently empty room in state "draft" and no hint why.
     * The chain knows the answer — RoomCreated carries the id — so the mismatch
     * is detectable, and saying it out loud is the difference between a
     * five-minute fix and a long hunt.
     */
    health() {
      const checks = config.rooms.map((configured) => {
        const indexed = [...store.rooms.values()].find(
          (row) =>
            String(row.live_room_address ?? "").toLowerCase() === String(configured.address ?? "").toLowerCase()
        );
        return {
          configured_room_id: configured.roomId,
          configured_address: configured.address,
          indexed_room_id: indexed?.room_id ?? null,
          room_matches_contract: indexed ? indexed.room_id === configured.roomId : null,
        };
      });
      const mismatch = checks.find((check) => check.room_matches_contract === false) ?? null;
      const allKnown = checks.every((check) => check.room_matches_contract === true);
      const matches = mismatch ? false : allKnown ? true : null;
      const primaryCheck = checks[0] ?? null;
      return {
        room_matches_contract: matches,
        // Kept for the original single-room response shape. Multi-room callers
        // use `rooms`, where every configured address has its own answer.
        indexed_room_id: checks.length === 1 ? primaryCheck?.indexed_room_id ?? null : null,
        rooms: checks,
        warning: mismatch
          ? `TM room id is "${mismatch.configured_room_id}" but the room at ${mismatch.configured_address} is ` +
            `"${mismatch.indexed_room_id}". This process will serve an empty room until they agree.`
          : null,
      };
    },

    /**
     * The numbers an operator scrapes. Anything this process has not measured
     * is omitted rather than exported as zero — a chain head of 0 reads as
     * "the chain is at genesis", and an alert on the lag derived from it would
     * page someone about a stall that is not happening.
     */
    async metrics() {
      const snapshot = primary.coordinator.snapshot();
      return {
        room_ids: [...roomRuntimes.keys()],
        chain_head: primary.coordinator.chainHead,
        indexer_cursor: store.cursorBlock,
        // How many times this process has seen the chain rewrite history it had
        // already indexed. Churn here is the difference between "the indexer is
        // fine" and "the indexer keeps rebuilding and never gets ahead", which
        // look identical on cursor and lag alone.
        reorgs_seen: reorgsSeen,
        // The slowest recent submission-to-execution. Null when nothing has
        // cleared: a room where actions are piling up unexecuted has no samples,
        // and a zero there would read as a perfectly fast room at the exact
        // moment one was failing. Past maxPendingTime these refund.
        epoch_clear_seconds: indexer.epochClearSeconds(),
        indexer_health: snapshot.health.indexer,
        stream_health: streamMonitor.health,
        source_health: snapshot.health.source,
        rooms_indexed: store.rooms.size,
        markets_indexed: store.markets.size,
        chat_messages: (
          await Promise.all([...roomRuntimes.values()].map((runtime) => runtime.chat.history()))
        ).reduce((total, history) => total + history.length, 0),
        // `durable`, not `Boolean(database)`: on PostgreSQL `database` is always
        // null, so this reported 0 while report() on the same process said
        // durable — and a severity=page rule fired forever on a correct deployment.
        non_chain_history_durable: durable,
        // Whether THIS process indexed the last tick, not a fresh check —
        // metrics scraping must not itself renew or steal a lease.
        replica_id: replicaId,
        leading,
        // What the authority processes have written about themselves. They run
        // separately with their own keys and catch their own errors, so a gate
        // that can never reach the chain fails quietly; this is the only place
        // that failure becomes visible from outside its own process. A role
        // nobody has heard from is absent, not healthy.
        operators: durableState ? await operatorHealth(durableState) : [],
        // The event log and the raw archive are never pruned — they are the
        // evidence a resolver reconstructs from and a challenger re-derives
        // from — so this only grows. When the disk fills, writes fail, the
        // connector stops recording facts, and the room suspends on a stale
        // source: a correct failure, reached for a reason nobody was watching.
        // Null, never zero, when this process holds history in memory: there
        // is no file, and a zero would read as a database using no disk.
        durable_bytes: durableBytes(),
        config_warning: this.health().warning,
      };
    },

    /** A credential-safe description of what this process actually has. */
    report() {
      return {
        room_id: config.rooms[0].roomId,
        chain_id: config.chainId,
        factory: config.factory,
        room: config.rooms[0].address,
        settlement_records: Boolean(settlement),
        software_notice: DEPLOYMENT_NOTICE,
        // Said plainly. Silence here is the worst outcome: an operator runs
        // it, restarts it, and only then discovers the evidence log is gone.
        rooms: [...roomRuntimes.values()].map((runtime) => ({ room_id: runtime.roomId, room: runtime.address })),
        durability: pgClient
          ? {
              non_chain_history: "durable",
              detail: `The session event log, raw source bytes, chat and its moderation, terms acceptances, and Livestream Event evidence metadata are stored in PostgreSQL (${redactedDatabaseUrl(config.databaseUrl) ?? "connection injected directly, not from TM_DATABASE_URL"}).${config.dataDir ? ` Complete recordings are in ${config.dataDir}/oracle-proofs.` : " No TM_DATA_DIR is set, so Livestream Event evidence upload is unavailable."} They survive a restart. Projections are rebuilt from chain. scripts/backup-postgres.mjs and scripts/restore-postgres.mjs carry the structured tables; evidence recordings still need their own directory backup, as with the SQLite path.`,
            }
          : database
          ? {
              non_chain_history: "durable",
              detail: `The session event log, raw source bytes, chat and its moderation, terms acceptances, and Livestream Event evidence metadata are stored in ${config.dataDir}/room.db; complete recordings are in ${config.dataDir}/oracle-proofs. They survive a restart and the backup command carries both. Projections are rebuilt from chain.`,
            }
          : {
              non_chain_history: "in-memory",
              detail:
                "No TM_DATA_DIR is set, so the session event log, raw source bytes, chat and its moderation, and terms acceptances are held in memory and lost on restart, and Livestream Event evidence upload is unavailable. Projections rebuild from chain either way.",
            },
        capabilities: capabilities.publicSnapshot().capabilities,
      };
    },

    /**
     * Replays the projections from genesis, serialized against polling.
     *
     * `rebuild` and `syncTo` share the cursor and the applied-log identities, so
     * a rebuild started while a poll is in flight clears that set underneath it
     * and every holding, trade and claim in the in-flight range is applied
     * twice.
     */
    async rebuild(headBlock) {
      while (syncing) await syncing;
      syncing = indexer.rebuild(headBlock);
      try {
        return await syncing;
      } finally {
        syncing = null;
      }
    },

    /**
     * One stream poll per room. Separate from the indexing pass because a
     * stream outage and a chain outage are different failures, and one must
     * never be reported as the other.
     *
     * Every room polls its own monitor and updates only its own coordinator —
     * see streamMonitorFor above for why one shared monitor across rooms was
     * a defect, not a simplification. Polled concurrently, not one room after
     * another: a slow or hanging manifest fetch for one room must not delay
     * every other room's health by the same amount.
     */
    async pollStream(nowMs = Date.now()) {
      // Not gated on leadership. Unlike syncOnce, this writes nothing shared —
      // it fetches a manifest and updates only this process's own in-memory
      // health and coordinators — so every replica, leader or not, needs its
      // own accurate answer to serve truthfully.
      const entries = await Promise.all(
        [...roomRuntimes.values()].map(async (runtime) => {
          const snapshot = await runtime.streamMonitor.poll(nowMs);
          runtime.coordinator.setStreamHealth(snapshot.health);
          return [runtime.roomId, snapshot];
        })
      );
      const snapshots = new Map(entries);
      const primarySnapshot = snapshots.get(primary.roomId);
      // Single-room surfaces speak for the primary room, as elsewhere.
      playback.health = primarySnapshot?.health ?? playback.health;
      return primarySnapshot;
    },

    /**
     * The rooms this replica currently holds the lease on.
     *
     * Per room, because the lease is per room. This used to demand every room
     * at once (`acquired.every(Boolean)`), which deadlocks the ordinary
     * two-replica/two-room case: each replica wins one, `every()` is false on
     * both, and since `tryAcquire` renews unconditionally for the current
     * holder the split never expires. Neither replica indexed anything, and
     * both served an empty room — a deployment added a replica for
     * availability and got less of it than with one.
     */
    async claimRooms(now = Date.now()) {
      const claimed = await Promise.all(
        config.rooms.map(async (room) =>
          (await leaderLease.tryAcquire(room.roomId, replicaId, leaseTtlMs, now)) ? room.roomId : null
        )
      );
      return claimed.filter(Boolean);
    },

    /**
     * Whether this replica leads anything at all.
     *
     * A process-level summary for the boot log, `/v1/health` and `/metrics`.
     * Nothing gates work on it — `syncOnce` indexes the rooms it actually
     * holds, which is not the same question.
     */
    async isLeading(now = Date.now()) {
      return (await this.claimRooms(now)).length > 0;
    },

    /** One indexing pass. Separated so a caller can drive it deterministically. */
    async syncOnce() {
      if (syncing) return syncing;
      syncing = (async () => {
        const led = await this.claimRooms();
        const nowLeading = led.length > 0;
        if (nowLeading !== leading || led.join(",") !== ledRooms.join(",")) {
          console.error(
            nowLeading
              ? `[leader] ${replicaId} now leads ${led.join(", ")}`
              : `[leader] ${replicaId} standing by — every configured room is held by another replica`
          );
        }
        leading = nowLeading;
        ledRooms = led;
        // A standby replica indexes nothing. Its own projections are
        // disposable and rebuild from chain (see the ProjectionStore note
        // above), so there is no partial-write hazard in skipping this pass —
        // but it also means a standby's own read surfaces stay exactly as
        // stale as they were the moment it lost, or never held, the lease.
        // That is a real, current limitation, not a documentation gap: a
        // replica pair today is active/cold-standby, not active/active-read.
        // Serving fresh reads from a standby needs a projection store shared
        // across replicas rather than one private to each process, which is
        // unbuilt. Recorded rather than implied away.
        if (led.length === 0) return indexer.cursorBlock;

        const head = await logs.head();
        // Reported before indexing, so a sync that fails still leaves the
        // coordinators able to say the indexer is behind.
        //
        // EVERY room this replica leads, not just the first. `coordinator` is
        // bound to `config.rooms[0]`, and driving only that object meant a
        // second room was constructed, served over HTTP and subscribable over
        // SSE while never being ticked: its viewers got `hello` and then
        // silence, forever, and its snapshot reported source sequence 0 and
        // `indexer: unknown` permanently.
        for (const roomId of led) {
          const runtime = roomRuntimes.get(roomId);
          if (!runtime) continue;
          runtime.coordinator.observeChainHead(head);
          // The event log's own port may now be PostgreSQL, so this is the one
          // place per pass that actually awaits it; snapshot()/_health() read
          // the cached result synchronously, exactly like chainHead above.
          runtime.coordinator.observeEventLogTip(await runtime.eventLog.tip());
        }

        // Before indexing forward, check the chain did not rewrite what is
        // already indexed. Detection existed as a method nothing called for the
        // whole of issue 06, which is the same defect as not having it: the
        // projections went on describing a chain that no longer existed, and
        // every surface fed by them described it too.
        const reorg = await indexer.detectReorg();
        if (reorg) {
          reorgsSeen += 1;
          if (reorg.beyondRetainedHistory) {
            // Loud, and not silently papered over. The indexer cannot say which
            // of its rows are still valid, so a rebuild here is a recovery from
            // an unknown state rather than a routine correction.
            console.error(
              `[indexer] REORG deeper than retained history at block ${reorg.from}: ` +
                "no common ancestor found, rebuilding from genesis"
            );
          } else {
            console.error(`[indexer] reorg at block ${reorg.from}, rolling back to ${reorg.commonAncestor}`);
          }
          await indexer.rewindTo(reorg.commonAncestor ?? 0, head);
        } else if (head > indexer.cursorBlock) {
          await indexer.syncTo(head);
        }
        for (const roomId of led) roomRuntimes.get(roomId)?.coordinator.tick();
        const health = this.health();
        // Reported once, when it first becomes knowable.
        if (health.warning && !warnedAboutRoom) {
          warnedAboutRoom = true;
          console.error(`[config] ${health.warning}`);
        }
        return indexer.cursorBlock;
      })();
      try {
        return await syncing;
      } finally {
        syncing = null;
      }
    },

    async start() {
      // Migration is async; construction above is not, so it happens here,
      // once, before anything reads or writes. Idempotent (schema_migration),
      // so re-running it against an already-migrated injected client is
      // harmless rather than something callers need to avoid.
      if (pgClient) await migratePostgres(pgClient);
      await server.listen(config.port);
      // A first sync that fails is reported and retried, not fatal: the
      // capabilities, help and entry surfaces are still worth serving, and
      // /v1/health reports the indexer as behind rather than pretending.
      try {
        await this.syncOnce();
      } catch (error) {
        console.error(`[indexer] first sync failed: ${error.message}`);
      }
      // The stream is polled on its own cadence: a chain that is behind must
      // not make the picture look down, and vice versa. Gated on ANY room
      // having a playback URL, not just the primary one — a process serving
      // several rooms where only the second has a stream configured must
      // still poll it, not skip polling because the first room has none.
      if ([...roomRuntimes.values()].some((runtime) => runtime.streamMonitor.playbackUrl)) {
        await this.pollStream();
        streamTimer = setInterval(() => {
          this.pollStream().catch((error) => console.error(`[stream] poll failed: ${error.message}`));
        }, config.streamPollMs);
        streamTimer.unref?.();
      }

      // Every room says it is alive on the cadence its own `hello` frame
      // advertises. `coordinator.heartbeat()` existed with NO production caller
      // while every client was told `heartbeat_ms: 10000`, so a quiet room
      // transmitted zero bytes and any proxy idle timeout (60-100s) killed
      // every viewer silently — while the client, promised a heartbeat, had no
      // reason to treat the silence as death.
      heartbeatTimer = setInterval(() => {
        for (const runtime of roomRuntimes.values()) {
          try {
            runtime.coordinator.heartbeat();
          } catch (error) {
            console.error(`[edge] heartbeat failed for ${runtime.roomId}: ${error.message}`);
          }
        }
      }, config.heartbeatMs);
      heartbeatTimer.unref?.();

      timer = setInterval(() => {
        this.syncOnce().catch((error) => {
          // A failed poll is reported, never smoothed over: stale projections
          // that look fresh are worse than an obvious gap.
          console.error(`[indexer] sync failed: ${error.message}`);
        });
      }, config.pollMs);
      timer.unref?.();
      return this.report();
    },

    async stop() {
      if (timer) clearInterval(timer);
      if (streamTimer) clearInterval(streamTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      database?.close?.();
      // A real Pool exposes end(); PGlite, injected in tests, exposes close()
      // instead. Whichever throws otherwise leaves the HTTP server below
      // never closed — a live listener that keeps the process up forever.
      if (pgClient) await (pgClient.end ? pgClient.end() : pgClient.close());
      await server.close();
    },
  };

  serviceRef.health = () => service.health();
  serviceRef.metrics = () => service.metrics();
  return service;
}
