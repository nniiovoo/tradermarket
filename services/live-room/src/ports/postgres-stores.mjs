// The PostgreSQL adapter.
//
// Same ports as `sqlite-stores.mjs`, same contract — `tests/helpers/store-contract.mjs`
// runs against both, unchanged, and that is the only thing that makes a second
// adapter safe. SQLite is retained as the local and test adapter; this is the
// one a deployment with more than one host can use.
//
// Two differences from SQLite are structural rather than incidental:
//
//   1. Everything here is async. SQLite's driver is synchronous, which is a
//      luxury of an in-process file and not a property of a durable store. The
//      port is async because the general case is; the SQLite adapter simply
//      satisfies it trivially.
//
//   2. `raw_blob` refs. SQLite mints `sqlite://raw/<id>`, and those refs are
//      written into the session event log — which is evidence a resolver
//      reconstructs from. A database migrated from SQLite therefore contains
//      refs in the old scheme, so this adapter mints `postgres://raw/<id>` for
//      new bytes and RESOLVES BOTH on read. Refusing the old scheme would make
//      every migrated market's evidence unreadable, which is indistinguishable
//      from evidence that was never recorded.
//
// The driver is injected rather than imported. `pg`, `postgres.js` and PGlite
// all expose a `query(sql, params) -> { rows }`, and taking that shape as the
// dependency is what lets the contract run in-process against real PostgreSQL
// without a server while a deployment uses a pooled client.

/** BigInt survives the round trip; a permit is mostly BigInts. */
function encode(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? { $bigint: item.toString() } : item));
}

function decode(text) {
  if (text === null || text === undefined) return null;
  return JSON.parse(text, (_key, item) =>
    item && typeof item === "object" && typeof item.$bigint === "string" ? BigInt(item.$bigint) : item
  );
}

/**
 * The schema, as one idempotent migration.
 *
 * Written as `create ... if not exists` rather than a numbered migration chain
 * because there is exactly one version of it so far. The moment a column has to
 * change shape rather than appear, this becomes a numbered chain — and that is
 * a change worth making deliberately rather than discovering halfway through.
 */
export const MIGRATIONS = [
  {
    id: "0001-initial",
    // One statement per entry rather than one blob. The extended query
    // protocol every serious driver uses accepts a single statement per
    // call, so a multi-statement string would work under one driver and
    // fail under the next — and the port's whole requirement is one
    // `query(sql, params)` method.
    statements: [
      `
      create table if not exists session_event (
            room_id text not null default '',
            seq     bigint not null,
            body    text not null,
            primary key (room_id, seq)
          )
      `,
      `
      create table if not exists raw_blob (
            ref   text primary key,
            bytes bytea not null
          )
      `,
      `
      create table if not exists kv (
            key   text primary key,
            value text not null
          )
      `,
      `
      create table if not exists chat_message (
            id      bigserial primary key,
            room_id text not null default '',
            author  text not null,
            label   text,
            text    text not null,
            at      text not null,
            deleted integer not null default 0
          )
      `,
      `
      create index if not exists chat_message_room on chat_message (room_id, id)
      `,
      `
      create table if not exists chat_timeout (
            room_id text not null default '',
            account text not null,
            until   bigint not null,
            primary key (room_id, account)
          )
      `,
      `
      create table if not exists chat_audit (
            id         bigserial primary key,
            room_id    text not null default '',
            moderator  text not null,
            action     text not null,
            message_id bigint,
            at         text not null
          )
      `,
      `
      create table if not exists referral_binding (
            account        text primary key,
            code           text not null,
            referrer       text not null,
            bound_at_block bigint,
            bound_at       text not null
          )
      `,
      `
      create index if not exists referral_binding_referrer on referral_binding (referrer)
      `,
      `
      create table if not exists terms_acceptance (
            account text primary key,
            version text not null,
            proven  integer not null default 0
          )
      `,
      `
      create table if not exists publication_request (
            id            bigserial primary key,
            room_id       text not null default '',
            status        text not null,
            candidate     text not null,
            request       text,
            restricted    text,
            condition_doc text,
            permit        text,
            signature     text,
            market        text,
            reason        text,
            attempts      integer not null default 0,
            submitted_at  text not null,
            updated_at    text not null
          )
      `,
      `
      create index if not exists publication_request_status on publication_request (room_id, status, id)
      `,
      `
      create table if not exists resolution_attempt (
            room_id       text not null default '',
            market        text not null,
            resolver      text not null,
            status        text not null,
            outcome       integer,
            evidence_hash text,
            reason        text,
            at            text not null,
            primary key (room_id, market, resolver)
          )
      `,
      `
      create table if not exists challenge_verdict (
            room_id  text not null default '',
            market   text not null,
            resolver text not null,
            accepted integer not null,
            outcome  integer,
            reason   text,
            at       text not null,
            primary key (room_id, market, resolver)
          )
      `,
      `
      create table if not exists livestream_oracle_proof (
            id             text primary key,
            market         text not null,
            outcome        integer not null,
            stream_url     text not null,
            occurred_at    text not null,
            clip_start_ms  bigint not null,
            clip_end_ms    bigint not null,
            rule           text not null,
            rationale      text not null,
            clip_sha256    text not null,
            evidence_hash  text not null unique,
            canonical_json text not null,
            video_path     text not null,
            byte_length    bigint not null,
            mime_type      text not null,
            created_at     text not null
          )
      `,
      `
      create index if not exists livestream_oracle_proof_market
            on livestream_oracle_proof (market, created_at desc)
      `,
      `
      create table if not exists livestream_challenge_evidence (
            evidence_hash    text primary key,
            market           text not null,
            evidence         text not null,
            transaction_hash text not null,
            challenger       text not null,
            created_at       text not null
          )
      `,
      `
      create index if not exists livestream_challenge_evidence_market
            on livestream_challenge_evidence (market, created_at desc)
      `,
      `
      create table if not exists schema_migration (
            id         text primary key,
            applied_at timestamptz not null default now()
          )
      `,
    ],
  },
  {
    id: "0002-leader-lease",
    // A genuinely new migration, not folded into 0001: that one is `create ...
    // if not exists` and re-runs harmlessly on an up-to-date database, but a
    // real deployment that already recorded "0001-initial" as applied would
    // never see a statement added to it afterward.
    statements: [
      `
      create table if not exists leader_lease (
            room_id    text primary key,
            holder     text not null,
            expires_at bigint not null,
            term       bigint not null default 1
          )
      `,
    ],
  },
]

/**
 * Applies every migration this build knows about, once.
 *
 * Idempotent: running it against an up-to-date database does nothing and says
 * so. A deployment runs this at startup rather than by hand, because a service
 * that boots against a schema it was not built for fails in ways that look like
 * data loss.
 */
export async function migrate(client) {
  await client.query(
    "create table if not exists schema_migration (id text primary key, applied_at timestamptz not null default now())"
  );
  const applied = new Set((await client.query("select id from schema_migration")).rows.map((row) => row.id));
  const ran = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.statements) await client.query(statement);
    await client.query("insert into schema_migration (id) values ($1) on conflict do nothing", [migration.id]);
    ran.push(migration.id);
  }
  return ran;
}

/**
 * Parses a Postgres connection string and returns it with its password
 * replaced — never the raw value, which is a credential and reaches this
 * function precisely because something is about to go into an error message
 * or a boot report. Null on anything that does not parse as `postgres(ql)://`.
 */
export function redactedDatabaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
  if (parsed.password) parsed.password = "redacted";
  return parsed.toString();
}

// --------------------------------------------------------------- backup

/**
 * Every durable table except `schema_migration`, which is schema bookkeeping
 * a restore repopulates itself by running `migrate()` — carrying it over
 * from a source build would fight the target build's own migration state
 * rather than help it.
 */
const BACKUP_TABLES = [
  "session_event",
  "raw_blob",
  "kv",
  "leader_lease",
  "chat_message",
  "chat_timeout",
  "chat_audit",
  "referral_binding",
  "terms_acceptance",
  "publication_request",
  "resolution_attempt",
  "challenge_verdict",
  "livestream_oracle_proof",
  "livestream_challenge_evidence",
];

/** The one `bytea` column in the whole schema. JSON has no byte-string type. */
const BYTEA_COLUMNS = { raw_blob: ["bytes"] };

/**
 * `bigserial` primary keys whose sequence a bulk restore must catch up by
 * hand. Inserting an explicit id does not advance the sequence object behind
 * it — only leaving the column to its own default does — so without this a
 * restore looks perfect right up until the first row written after recovery,
 * which then collides with (or is silently skipped behind) an id that
 * already means something.
 */
const SERIAL_COLUMNS = { chat_message: "id", chat_audit: "id", publication_request: "id" };

const BACKUP_FORMAT = "tradermarket-postgres-backup-v1";

/**
 * A logical backup: every row of every durable table, read out through the
 * same `query(sql, params) -> { rows }` contract every adapter already
 * commits to — so this is exactly as portable across `pg`, `postgres.js` and
 * PGlite as the stores above it are, with no server-side tool (`pg_dump`,
 * `pg_basebackup`) in the loop.
 *
 * Below the domain layer, like `backupDatabase()` for SQLite: an
 * already-JSON-encoded column (a permit, a publication request's candidate)
 * is carried verbatim as the opaque string it already is, not decoded and
 * re-encoded here.
 */
export async function pgBackup(client) {
  const tables = {};
  for (const table of BACKUP_TABLES) {
    const { rows } = await client.query(`select * from ${table}`);
    const byteaColumns = BYTEA_COLUMNS[table] ?? [];
    tables[table] = rows.map((row) => {
      if (byteaColumns.length === 0) return row;
      const copy = { ...row };
      for (const column of byteaColumns) {
        if (copy[column] != null) copy[column] = Buffer.from(copy[column]).toString("base64");
      }
      return copy;
    });
  }
  return { format: BACKUP_FORMAT, capturedAt: new Date().toISOString(), tables };
}

/**
 * Replays a `pgBackup()` snapshot into `client`.
 *
 * Refuses a target that already holds data, the same way `backupDatabase()`
 * refuses to overwrite an existing destination file: restore is a
 * disaster-recovery operation whose target is supposed to be the empty
 * replacement for what was lost, and with `on conflict do nothing` a dirty
 * target would not error, it would silently drop every colliding row instead
 * — the worse failure to ship by default.
 */
export async function pgRestore(client, snapshot) {
  if (snapshot?.format !== BACKUP_FORMAT) {
    throw new Error(`unrecognised backup format: ${JSON.stringify(snapshot?.format ?? null)}`);
  }
  await migrate(client);
  for (const table of BACKUP_TABLES) {
    const { rows: existing } = await client.query(`select 1 from ${table} limit 1`);
    if (existing.length > 0) {
      throw new Error(`refusing to restore: "${table}" already has rows. The target must be empty.`);
    }
  }

  const captured = {};
  for (const table of BACKUP_TABLES) {
    const rows = snapshot.tables?.[table] ?? [];
    const byteaColumns = BYTEA_COLUMNS[table] ?? [];
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((column) =>
        byteaColumns.includes(column) && row[column] != null ? Buffer.from(row[column], "base64") : row[column]
      );
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      await client.query(
        `insert into ${table} (${columns.join(", ")}) values (${placeholders}) on conflict do nothing`,
        values
      );
    }
    captured[table] = rows.length;

    const serialColumn = SERIAL_COLUMNS[table];
    if (serialColumn && rows.length > 0) {
      await client.query(
        `select setval(pg_get_serial_sequence('${table}', '${serialColumn}'), ` +
          `coalesce((select max(${serialColumn}) from ${table}), 1), ` +
          `(select max(${serialColumn}) from ${table}) is not null)`
      );
    }
  }
  return captured;
}

// ---------------------------------------------------------------- stores

export class PostgresEventStore {
  constructor(client, roomId = null) {
    this.client = client;
    this.roomId = roomId === null ? null : String(roomId);
  }

  forRoom(roomId) {
    return new PostgresEventStore(this.client, roomId);
  }

  async tip() {
    const { rows } =
      this.roomId === null
        ? await this.client.query("select body from session_event order by room_id, seq desc limit 1")
        : await this.client.query("select body from session_event where room_id = $1 order by seq desc limit 1", [
            this.roomId,
          ]);
    return rows.length ? JSON.parse(rows[0].body) : null;
  }

  async append(event) {
    const eventRoom = String(event?.room_id ?? "");
    if (this.roomId !== null && eventRoom && eventRoom !== this.roomId) {
      throw new Error(`event belongs to room ${eventRoom}, not ${this.roomId}`);
    }
    const roomId = this.roomId ?? eventRoom;
    const normalized = this.roomId !== null && !eventRoom ? { ...event, room_id: this.roomId } : event;

    const { rows } = await this.client.query(
      "select body from session_event where room_id = $1 order by seq desc limit 1",
      [roomId]
    );
    const tip = rows.length ? JSON.parse(rows[0].body) : null;
    const expected = tip ? tip.seq + 1 : 1;
    // Refused here, not repaired later: the log is the evidence a resolver
    // reconstructs from, and a gap accepted at the store is a hole nothing
    // downstream can detect.
    if (event.seq !== expected) throw new Error(`append gap: got ${event.seq}, expected ${expected}`);

    await this.client.query("insert into session_event (room_id, seq, body) values ($1, $2, $3)", [
      roomId,
      event.seq,
      JSON.stringify(normalized),
    ]);
  }

  async all() {
    const { rows } =
      this.roomId === null
        ? await this.client.query("select body from session_event order by room_id, seq asc")
        : await this.client.query("select body from session_event where room_id = $1 order by seq asc", [this.roomId]);
    return rows.map((row) => JSON.parse(row.body));
  }

  async slice(fromSeq, toSeq = Number.MAX_SAFE_INTEGER) {
    const last = Math.min(toSeq, Number.MAX_SAFE_INTEGER);
    const { rows } =
      this.roomId === null
        ? await this.client.query(
            "select body from session_event where seq >= $1 and seq <= $2 order by room_id, seq asc",
            [fromSeq, last]
          )
        : await this.client.query(
            "select body from session_event where room_id = $1 and seq >= $2 and seq <= $3 order by seq asc",
            [this.roomId, fromSeq, last]
          );
    return rows.map((row) => JSON.parse(row.body));
  }
}

export class PostgresRawArchive {
  constructor(client) {
    this.client = client;
  }

  async put(id, bytes) {
    const ref = `postgres://raw/${id}`;
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await this.client.query(
      "insert into raw_blob (ref, bytes) values ($1, $2) on conflict (ref) do update set bytes = excluded.bytes",
      [ref, new Uint8Array(buffer)]
    );
    return ref;
  }

  /**
   * Resolves a ref in either scheme.
   *
   * A database migrated from SQLite carries `sqlite://raw/<id>` refs inside the
   * session event log, and that log is evidence. Refusing the old scheme would
   * make every migrated market's evidence unreadable — which a resolver cannot
   * distinguish from evidence that was never recorded, and which therefore
   * turns a storage migration into an invalidation.
   */
  async get(ref) {
    const { rows } = await this.client.query("select bytes from raw_blob where ref = $1", [ref]);
    if (rows.length) return Buffer.from(rows[0].bytes);

    const legacy = String(ref ?? "").match(/^(?:sqlite|postgres):\/\/raw\/(.+)$/);
    if (!legacy) return null;
    const { rows: byId } = await this.client.query("select bytes from raw_blob where ref = $1 or ref = $2", [
      `postgres://raw/${legacy[1]}`,
      `sqlite://raw/${legacy[1]}`,
    ]);
    return byId.length ? Buffer.from(byId[0].bytes) : null;
  }
}

export class PostgresKeyValue {
  constructor(client) {
    this.client = client;
  }

  async get(key, fallback = null) {
    const { rows } = await this.client.query("select value from kv where key = $1", [key]);
    return rows.length ? JSON.parse(rows[0].value) : fallback;
  }

  async set(key, value) {
    await this.client.query(
      "insert into kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
      [key, JSON.stringify(value)]
    );
  }
}

/**
 * Per-room leader election over a lease with a bounded lifetime. Same
 * contract as `SqliteLeaderLease` — see there for why the WHERE-conditioned
 * upsert is the whole mechanism.
 */
export class PostgresLeaderLease {
  constructor(client) {
    this.client = client;
  }

  /** Acquires or renews the lease for `roomId`; null when another holder still owns it. */
  async tryAcquire(roomId, holder, ttlMs, now = Date.now()) {
    const { rows } = await this.client.query(
      `insert into leader_lease (room_id, holder, expires_at, term)
       values ($1, $2, $3, 1)
       on conflict (room_id) do update set
         holder = excluded.holder,
         expires_at = excluded.expires_at,
         term = leader_lease.term + case when leader_lease.holder = excluded.holder then 0 else 1 end
       where leader_lease.expires_at <= $4 or leader_lease.holder = excluded.holder
       returning term, expires_at`,
      [String(roomId), holder, now + ttlMs, now]
    );
    return rows.length ? { holder, term: Number(rows[0].term), expiresAt: Number(rows[0].expires_at) } : null;
  }
}

// Same tombstone values as the SQLite adapter — see there for why an erased
// account's identity becomes a marker rather than an empty string.
const ERASED = "[erased]";
const ERASED_TEXT = "[removed by the account holder]";

export class PostgresChatStore {
  constructor(client, roomId = "") {
    this.client = client;
    this.roomId = roomId;
  }

  forRoom(roomId) {
    return new PostgresChatStore(this.client, roomId);
  }

  async append({ author, label = null, text, at }) {
    const { rows } = await this.client.query(
      "insert into chat_message (room_id, author, label, text, at) values ($1, $2, $3, $4, $5) returning id",
      [this.roomId, author, label, text, at]
    );
    return { id: Number(rows[0].id), author, label, text, at, presentation_only: true };
  }

  async history(sinceId = 0) {
    const { rows } = await this.client.query(
      "select * from chat_message where room_id = $1 and id > $2 and deleted = 0 order by id asc",
      [this.roomId, sinceId]
    );
    return rows.map((row) => ({
      id: Number(row.id),
      author: row.author,
      label: row.label,
      text: row.text,
      at: row.at,
      presentation_only: true,
    }));
  }

  async find(id) {
    const { rows } = await this.client.query("select * from chat_message where room_id = $1 and id = $2", [
      this.roomId,
      id,
    ]);
    return rows.length
      ? { id: Number(rows[0].id), author: rows[0].author, text: rows[0].text, at: rows[0].at }
      : null;
  }

  async delete(id) {
    await this.client.query("update chat_message set deleted = 1 where room_id = $1 and id = $2", [this.roomId, id]);
  }

  async setTimeout(account, untilMs) {
    await this.client.query(
      "insert into chat_timeout (room_id, account, until) values ($1, $2, $3) " +
        "on conflict (room_id, account) do update set until = excluded.until",
      [this.roomId, String(account).toLowerCase(), untilMs]
    );
  }

  async timeoutFor(account) {
    const { rows } = await this.client.query("select until from chat_timeout where room_id = $1 and account = $2", [
      this.roomId,
      String(account).toLowerCase(),
    ]);
    return rows.length ? Number(rows[0].until) : 0;
  }

  async audit(entry) {
    await this.client.query(
      "insert into chat_audit (room_id, moderator, action, message_id, at) values ($1, $2, $3, $4, $5)",
      [this.roomId, entry.moderator, entry.action, entry.messageId ?? null, entry.at]
    );
  }

  async auditLog() {
    const { rows } = await this.client.query("select * from chat_audit where room_id = $1 order by id asc", [
      this.roomId,
    ]);
    return rows.map((row) => ({
      id: Number(row.id),
      moderator: row.moderator,
      action: row.action,
      messageId: row.message_id === null ? null : Number(row.message_id),
      at: row.at,
    }));
  }

  async prune({ nowMs, maxMessages }) {
    await this.client.query("delete from chat_timeout where room_id = $1 and until <= $2", [this.roomId, nowMs]);
    await this.client.query(
      `delete from chat_message where room_id = $1 and id <= (
         select id from chat_message where room_id = $1 order by id desc offset $2 limit 1
       )`,
      [this.roomId, maxMessages]
    );
  }

  /**
   * Removes one account's authorship from every room, not just this one —
   * see `SqliteChatStore.eraseAccount` for why this deliberately ignores
   * `this.roomId` where every other method here honours it.
   */
  async eraseAccount(account) {
    const key = String(account).toLowerCase();
    const messages = await this.client.query(
      "update chat_message set author = $1, text = $2 where lower(author) = $3 returning id",
      [ERASED, ERASED_TEXT, key]
    );
    const timeouts = await this.client.query("delete from chat_timeout where account = $1 returning room_id", [key]);
    return { messagesErased: messages.rows.length, timeoutsCleared: timeouts.rows.length };
  }
}

export class PostgresReferralStore {
  constructor(client) {
    this.client = client;
  }

  /** No upsert, deliberately: a rebind must fail, not silently reassign. */
  async bind({ account, code, referrer, atBlock = null, at = new Date().toISOString() }) {
    await this.client.query(
      "insert into referral_binding (account, code, referrer, bound_at_block, bound_at) values ($1, $2, $3, $4, $5)",
      [String(account).toLowerCase(), code, String(referrer).toLowerCase(), atBlock, at]
    );
  }

  async bindingFor(account) {
    const { rows } = await this.client.query("select * from referral_binding where account = $1", [
      String(account).toLowerCase(),
    ]);
    return rows.length ? this._row(rows[0]) : null;
  }

  async bindingsBy(referrer) {
    const { rows } = await this.client.query("select * from referral_binding where referrer = $1", [
      String(referrer).toLowerCase(),
    ]);
    return rows.map((row) => this._row(row));
  }

  /** Same split as `SqliteReferralStore.eraseAccount`: own binding deleted, referrer role redacted. */
  async eraseAccount(account) {
    const key = String(account).toLowerCase();
    const own = await this.client.query("delete from referral_binding where account = $1 returning account", [key]);
    const asReferrer = await this.client.query(
      "update referral_binding set referrer = $1 where referrer = $2 returning account",
      [ERASED, key]
    );
    return { ownBindingDeleted: own.rows.length > 0, referredBindingsRedacted: asReferrer.rows.length };
  }

  _row(row) {
    return {
      account: row.account,
      code: row.code,
      referrer: row.referrer,
      boundAtBlock: row.bound_at_block === null ? null : Number(row.bound_at_block),
      boundAt: row.bound_at,
    };
  }
}

export class PostgresAcceptanceStore {
  constructor(client) {
    this.client = client;
  }

  /** `undefined`, not null: callers distinguish "never accepted" from a value. */
  async get(account) {
    const { rows } = await this.client.query("select version from terms_acceptance where account = $1", [
      String(account).toLowerCase(),
    ]);
    return rows.length ? rows[0].version : undefined;
  }

  async set(account, version) {
    await this.client.query(
      "insert into terms_acceptance (account, version) values ($1, $2) " +
        "on conflict (account) do update set version = excluded.version",
      [String(account).toLowerCase(), version]
    );
  }

  async proven(account) {
    const { rows } = await this.client.query("select proven from terms_acceptance where account = $1", [
      String(account).toLowerCase(),
    ]);
    return rows.length ? Boolean(Number(rows[0].proven)) : false;
  }

  async setProven(account, proven) {
    await this.client.query("update terms_acceptance set proven = $1 where account = $2", [
      proven ? 1 : 0,
      String(account).toLowerCase(),
    ]);
  }

  /** Same open question as `SqliteAcceptanceStore.eraseAccount` — see there. */
  async eraseAccount(account) {
    const { rows } = await this.client.query("delete from terms_acceptance where account = $1 returning account", [
      String(account).toLowerCase(),
    ]);
    return { deleted: rows.length > 0 };
  }
}

export class PostgresResolutionLog {
  constructor(client, roomId = "", resolver = "") {
    this.client = client;
    this.roomId = roomId;
    this.resolver = String(resolver).toLowerCase();
  }

  async record(market, { status, outcome = null, evidenceHash = null, reason = null, at = new Date().toISOString() }) {
    await this.client.query(
      `insert into resolution_attempt (room_id, market, resolver, status, outcome, evidence_hash, reason, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (room_id, market, resolver) do update set
         status = excluded.status, outcome = excluded.outcome,
         evidence_hash = excluded.evidence_hash, reason = excluded.reason, at = excluded.at`,
      [this.roomId, String(market).toLowerCase(), this.resolver, status, outcome, evidenceHash, reason, at]
    );
  }

  async get(market) {
    const { rows } = await this.client.query(
      "select * from resolution_attempt where room_id = $1 and market = $2 and resolver = $3",
      [this.roomId, String(market).toLowerCase(), this.resolver]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      market: row.market,
      resolver: row.resolver,
      status: row.status,
      outcome: row.outcome === null ? null : Number(row.outcome),
      evidenceHash: row.evidence_hash,
      reason: row.reason,
      at: row.at,
    };
  }

  async attested(market) {
    return (await this.get(market))?.status === "attested";
  }

  /** `do nothing` on conflict: a resolver votes once. */
  async recordVerdict(market, { accepted, outcome = null, reason = null, at = new Date().toISOString() }) {
    await this.client.query(
      `insert into challenge_verdict (room_id, market, resolver, accepted, outcome, reason, at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (room_id, market, resolver) do nothing`,
      [this.roomId, String(market).toLowerCase(), this.resolver, accepted ? 1 : 0, outcome, reason, at]
    );
  }

  async verdict(market) {
    const { rows } = await this.client.query(
      "select * from challenge_verdict where room_id = $1 and market = $2 and resolver = $3",
      [this.roomId, String(market).toLowerCase(), this.resolver]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      market: row.market,
      accepted: Number(row.accepted) === 1,
      outcome: row.outcome === null ? null : Number(row.outcome),
      reason: row.reason,
      at: row.at,
    };
  }

  async all() {
    const { rows } = await this.client.query(
      "select * from resolution_attempt where room_id = $1 and resolver = $2 order by at asc",
      [this.roomId, this.resolver]
    );
    return rows.map((row) => ({
      market: row.market,
      status: row.status,
      outcome: row.outcome === null ? null : Number(row.outcome),
      evidenceHash: row.evidence_hash,
      reason: row.reason,
      at: row.at,
    }));
  }
}

export class PostgresOracleProofStore {
  constructor(client) {
    this.client = client;
  }

  async put(record) {
    await this.client.query(
      `insert into livestream_oracle_proof (
         id, market, outcome, stream_url, occurred_at, clip_start_ms, clip_end_ms,
         rule, rationale, clip_sha256, evidence_hash, canonical_json, video_path,
         byte_length, mime_type, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (id) do nothing`,
      [
        record.id,
        record.market,
        record.outcome,
        record.stream_url,
        record.occurred_at,
        record.clip_start_ms,
        record.clip_end_ms,
        record.rule,
        record.rationale,
        record.clip_sha256,
        record.evidence_hash,
        record.canonical_json,
        record.video_path,
        record.byte_length,
        record.mime_type,
        record.created_at,
      ]
    );
    return this.byId(record.id);
  }

  async byId(id) {
    return this._one("select * from livestream_oracle_proof where id = $1", [id]);
  }

  async byEvidenceHash(evidenceHash) {
    return this._one("select * from livestream_oracle_proof where evidence_hash = $1", [evidenceHash]);
  }

  async latestForMarket(market) {
    return this._one(
      "select * from livestream_oracle_proof where market = $1 order by created_at desc, id desc limit 1",
      [market]
    );
  }

  async putChallenge(record) {
    await this.client.query(
      `insert into livestream_challenge_evidence (evidence_hash, market, evidence, transaction_hash, challenger, created_at)
       values ($1,$2,$3,$4,$5,$6) on conflict (evidence_hash) do nothing`,
      [record.evidence_hash, record.market, record.evidence, record.transaction_hash, record.challenger, record.created_at]
    );
    return this.challengeByEvidenceHash(record.evidence_hash);
  }

  async challengeByEvidenceHash(evidenceHash) {
    return this._one("select * from livestream_challenge_evidence where evidence_hash = $1", [evidenceHash]);
  }

  async latestChallengeForMarket(market) {
    return this._one(
      "select * from livestream_challenge_evidence where market = $1 order by created_at desc limit 1",
      [market]
    );
  }

  async _one(sql, params) {
    const { rows } = await this.client.query(sql, params);
    if (!rows.length) return null;
    const row = { ...rows[0] };
    // bigint columns come back as strings from some drivers; the callers treat
    // these as numbers and a silent string would compare wrong.
    for (const key of ["outcome", "clip_start_ms", "clip_end_ms", "byte_length", "id"]) {
      if (key in row && row[key] !== null && key !== "id") row[key] = Number(row[key]);
    }
    return row;
  }
}

export class PostgresPublicationQueue {
  constructor(client, roomId = "") {
    this.client = client;
    this.roomId = roomId;
  }

  _row(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      roomId: row.room_id,
      status: row.status,
      candidate: decode(row.candidate),
      request: decode(row.request),
      restricted: decode(row.restricted) ?? [],
      conditionDocument: decode(row.condition_doc),
      permit: decode(row.permit),
      signature: row.signature ?? null,
      market: row.market ?? null,
      reason: row.reason ?? null,
      attempts: Number(row.attempts ?? 0),
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
    };
  }

  async submit(candidate, at = new Date().toISOString()) {
    const { rows } = await this.client.query(
      "insert into publication_request (room_id, status, candidate, submitted_at, updated_at) " +
        "values ($1, 'queued', $2, $3, $4) returning id",
      [this.roomId, encode(candidate), at, at]
    );
    return { id: Number(rows[0].id) };
  }

  async get(id) {
    const { rows } = await this.client.query("select * from publication_request where id = $1 and room_id = $2", [
      id,
      this.roomId,
    ]);
    return this._row(rows[0]);
  }

  async byStatus(status) {
    const { rows } = await this.client.query(
      "select * from publication_request where room_id = $1 and status = $2 order by id asc",
      [this.roomId, status]
    );
    return rows.map((row) => this._row(row));
  }

  async queued() {
    return this.byStatus("queued");
  }

  async awaitingPermit() {
    return this.byStatus("awaiting_permit");
  }

  async permitted() {
    return this.byStatus("permitted");
  }

  async published() {
    return this.byStatus("published");
  }

  async conditionForMarket(market) {
    const { rows } = await this.client.query(
      "select * from publication_request where room_id = $1 and status = 'published' and lower(market) = lower($2) " +
        "order by id desc limit 1",
      [this.roomId, market]
    );
    return this._row(rows[0]);
  }

  async open() {
    const { rows } = await this.client.query(
      "select * from publication_request where room_id = $1 and status in ('queued','awaiting_permit','permitted') " +
        "order by id asc",
      [this.roomId]
    );
    return rows.map((row) => this._row(row));
  }

  async all() {
    const { rows } = await this.client.query(
      "select * from publication_request where room_id = $1 order by id asc",
      [this.roomId]
    );
    return rows.map((row) => this._row(row));
  }

  async _transition(id, status, patch = {}) {
    const columns = { status, updated_at: new Date().toISOString(), ...patch };
    const keys = Object.keys(columns);
    const assignments = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
    await this.client.query(
      `update publication_request set ${assignments} where id = $${keys.length + 1} and room_id = $${keys.length + 2}`,
      [...keys.map((key) => columns[key]), id, this.roomId]
    );
    return this.get(id);
  }

  async markAwaitingPermit(id, { request, restricted, conditionDocument }) {
    return this._transition(id, "awaiting_permit", {
      request: encode(request),
      restricted: encode(restricted ?? []),
      condition_doc: encode(conditionDocument),
      reason: null,
    });
  }

  async markRejected(id, reason) {
    return this._transition(id, "rejected", { reason });
  }

  async markPermitted(id, { permit, signature, request }) {
    return this._transition(id, "permitted", {
      permit: encode(permit),
      signature,
      request: encode(request),
      reason: null,
    });
  }

  async markRefused(id, reason) {
    return this._transition(id, "refused", { reason });
  }

  async markPublished(id, { market }) {
    return this._transition(id, "published", { market, reason: null });
  }

  async markFailed(id, reason) {
    return this._transition(id, "failed", { reason });
  }

  async reopenForPermit(id, reason) {
    const current = await this.get(id);
    return this._transition(id, "awaiting_permit", {
      reason,
      attempts: (current?.attempts ?? 0) + 1,
      permit: null,
      signature: null,
    });
  }
}
