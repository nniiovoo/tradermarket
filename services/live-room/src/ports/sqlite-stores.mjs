// Durable non-chain history.
//
// The projections in this system are disposable by design: drop them and they
// rebuild from chain logs, which is what makes them safe to hold in memory.
// Everything in this file is the opposite — it cannot be rebuilt from anywhere:
//
//   - the Session Event Log and its hash chain, which is the evidence a
//     resolver reconstructs a result from;
//   - the raw provider bytes that log commits to;
//   - chat, its moderation and the record of who moderated what;
//   - who accepted which terms version, and whether they proved it;
//   - the Gate Authority's nonces and audit, which stop a restart from
//     replaying a permit.
//   - immutable metadata and content hashes for complete Livestream Event
//     recordings (the large MP4 bytes live beside the database).
//
// Holding those in memory means a restart silently erases the only copy. SQLite
// rather than a server: it is in the Node standard library, so durability costs
// no dependency and no operational component. The backup command snapshots the
// database and carries the adjacent immutable recording directory with it.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Opens (and migrates) a database file, or an in-memory one for tests. */
export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // The busy timeout comes FIRST, before anything that takes a lock.
  //
  // Switching the journal mode is itself a locking operation, so on a file
  // another process is writing, `pragma journal_mode = wal` threw "database is
  // locked" — during open, before any timeout had been set to wait on. The
  // process did not lose a write: it failed to start at all, and under a
  // supervisor that restarts always, it would do that in a loop for as long as
  // its neighbour kept writing.
  //
  // Wait for the write lock instead of giving up on it.
  //
  // The gate, publisher, connector, resolver and Coordinator run as separate
  // processes on one data directory — that separation is the point, since no
  // process may hold two authority keys — so five writers share this file. WAL
  // allows one at a time, and with no busy timeout SQLite does not queue: it
  // returns "database is locked" immediately. Measured at roughly two writes in
  // five lost under that exact layout, silently, across the gate's permit nonce
  // counter and audit, the connector's cursors and signed events, chat,
  // acceptances and referral bindings.
  //
  // The nonce is the one that stings: it is persisted BEFORE a permit is handed
  // out so that a crash cannot reissue it, and a lost write there gives that
  // guarantee away.
  db.exec("pragma busy_timeout = 10000");
  // WAL so a reader and the writer do not block each other, and normal
  // synchronous so a crash cannot tear a committed transaction.
  ensureWal(db);
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  migrate(db);
  return db;
}

/**
 * A consistent copy of the durable state, taken while the service is running.
 *
 * Every structured fact the chain cannot rebuild is in this file: the signed event log,
 * the raw provider bytes a resolver reconstructs from, chat, acceptances,
 * referral bindings, the gate's permit nonce counter and audit, the poller's
 * cursors, and references/hashes for adjacent evidence recordings. `cp` is not a backup of it — with WAL the committed data may be in a
 * second file and the main one may be mid-write, so the copy can be a database
 * that opens and is quietly missing the last hour.
 *
 * `vacuum into` takes the copy through SQLite itself: a single consistent
 * snapshot of committed state, with no need to stop the writer. The backup
 * script then copies the immutable recording directory. A backup that
 * can only be taken while stopped is a backup nobody takes.
 *
 * It refuses an existing destination. Backups are run by cron and by people in
 * a hurry, and silently replacing yesterday's good copy — at the moment someone
 * is reaching for yesterday's — is how a backup system does more harm than none.
 */
export function backupDatabase(database, destination) {
  if (existsSync(destination)) {
    throw new Error(`${destination} exists; refusing to overwrite a backup. Choose another name.`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  // A literal, because `vacuum into` takes no bound parameter.
  database.exec(`vacuum into '${destination.replace(/'/g, "''")}'`);

  // Report what was actually captured, so a backup that ran but caught nothing
  // is distinguishable from one that caught a session.
  const copy = new DatabaseSync(destination, { readOnly: true });
  const count = (table) => {
    try {
      return Number(copy.prepare(`select count(*) as n from ${table}`).get().n);
    } catch {
      return 0;
    }
  };
  const captured = {
    path: destination,
    events: count("session_event"),
    raw_blobs: count("raw_blob"),
    chat_messages: count("chat_message"),
    keys: count("kv"),
    oracle_proofs: count("livestream_oracle_proof"),
  };
  copy.close();
  return captured;
}

/**
 * Puts the file in WAL mode, tolerating the race to do so.
 *
 * Changing the journal mode takes an EXCLUSIVE lock and does not wait for one:
 * the busy timeout above does not apply to it, so a process opening the file
 * while a neighbour was writing threw "database is locked" during open and
 * never started at all. Under a supervisor that restarts always, it would do
 * that in a loop for as long as the neighbour kept writing.
 *
 * The mode is a property of the file, not of the connection, so it only has to
 * be set once. Losing the race to set it is not a failure — provided the
 * process that won set the mode we wanted.
 */
function ensureWal(db, attempts = 40, waitMs = 25) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const current = String(db.prepare("pragma journal_mode").get()?.journal_mode ?? "").toLowerCase();
      if (current === "wal") return;
      db.exec("pragma journal_mode = wal");
      return;
    } catch (error) {
      // Even reading the mode is refused while the exclusive lock is held, so
      // there is nothing to inspect until it is released. It is held only for
      // the duration of another process's switch, so waiting is the answer —
      // and `DatabaseSync` is synchronous, so the wait has to be too.
      if (attempt === attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

/** The whole schema, applied idempotently on every open. */
function migrate(db) {
  db.exec(`
    create table if not exists session_event (
      room_id     text not null default '',
      seq         integer not null,
      body        text not null,
      primary key (room_id, seq)
    );

    create table if not exists raw_blob (
      ref   text primary key,
      bytes blob not null
    );

    create table if not exists kv (
      key   text primary key,
      value text not null
    );

    -- One row per room: who currently leads it, and until when. A replica
    -- that is not the holder and finds the lease unexpired must not index —
    -- that is the entire mechanism multi-replica safety needs.
    create table if not exists leader_lease (
      room_id    text primary key,
      holder     text not null,
      expires_at integer not null,
      term       integer not null default 1
    );

    create table if not exists chat_message (
      id      integer primary key autoincrement,
      room_id text not null default '',
      author  text not null,
      label   text,
      text    text not null,
      at      text not null,
      deleted integer not null default 0
    );

    -- A timeout is per room: being muted in one room is not being muted in
    -- every room this process happens to serve.
    create table if not exists chat_timeout (
      room_id text not null default '',
      account text not null,
      until   integer not null,
      primary key (room_id, account)
    );

    create table if not exists chat_audit (
      id         integer primary key autoincrement,
      room_id    text not null default '',
      moderator  text not null,
      action     text not null,
      message_id integer,
      at         text not null
    );

    -- A referral binding: who was referred, by whose code, at which block, and
    -- the signature that proves the referred person made the binding.
    create table if not exists referral_binding (
      account   text primary key,
      code      text not null,
      referrer  text not null,
      bound_at_block integer,
      bound_at  text not null
    );

    create table if not exists terms_acceptance (
      account text primary key,
      version text not null,
      proven  integer not null default 0
    );

    -- The publication request channel between the Gate and the Publisher.
    --
    -- These are two processes holding two different keys, so they need
    -- somewhere to hand work to each other that outlives a restart of either.
    -- Without it, "the publisher was restarted" silently means "the question
    -- you queued is gone" — which from outside looks exactly like a question
    -- nobody ever asked.
    create table if not exists publication_request (
      id            integer primary key autoincrement,
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
    );

    create index if not exists publication_request_status
      on publication_request (room_id, status, id);

    -- What this resolver has already attested, and what it refused to.
    --
    -- The contract rejects a duplicate attestation, so a resolver that forgets
    -- does not double-attest — it burns a transaction to find out, every tick,
    -- forever. A refusal is recorded for the opposite reason: a market this
    -- resolver will not attest is an operator's problem and has to be visible
    -- as one rather than as silence.
    create table if not exists resolution_attempt (
      room_id      text not null default '',
      market       text not null,
      resolver     text not null,
      status       text not null,
      outcome      integer,
      evidence_hash text,
      reason       text,
      at           text not null,
      primary key (room_id, market, resolver)
    );

    -- A resolver's vote on a bonded audience challenge.
    --
    -- Separate from resolution_attempt on purpose. That table holds ONE row per
    -- (room, market, resolver) and upserts, so recording a verdict there erased
    -- the record of having attested — and the next tick, seeing no attestation,
    -- attested again. Two facts about the same market needed two rows.
    create table if not exists challenge_verdict (
      room_id  text not null default '',
      market   text not null,
      resolver text not null,
      accepted integer not null,
      outcome  integer,
      reason   text,
      at       text not null,
      primary key (room_id, market, resolver)
    );

    -- Canonical evidence for human-reviewed livestream event questions.
    --
    -- The complete observation recording is kept as a file because a large video blob would make every
    -- SQLite backup and WAL checkpoint unnecessarily expensive. This row is
    -- the durable, queryable commitment: immutable market/rule/timestamps,
    -- the recording's SHA-256, and the keccak256 hash two independent resolver
    -- wallets attest on chain.
    create table if not exists livestream_oracle_proof (
      id              text primary key,
      market          text not null,
      outcome         integer not null,
      stream_url      text not null,
      occurred_at     text not null,
      clip_start_ms   integer not null,
      clip_end_ms     integer not null,
      rule            text not null,
      rationale       text not null,
      clip_sha256     text not null,
      evidence_hash   text not null unique,
      canonical_json  text not null,
      video_path      text not null,
      byte_length     integer not null,
      mime_type       text not null,
      created_at      text not null
    );

    create index if not exists livestream_oracle_proof_market
      on livestream_oracle_proof (market, created_at desc);

    -- The preimage/reference for a bonded on-chain Resolution Challenge. The
    -- API inserts this only after verifying the named transaction really
    -- called challengeResult with this hash on this market.
    create table if not exists livestream_challenge_evidence (
      evidence_hash    text primary key,
      market           text not null,
      evidence         text not null,
      transaction_hash text not null unique,
      challenger       text not null,
      created_at       text not null
    );

    create index if not exists livestream_challenge_evidence_market
      on livestream_challenge_evidence (market, created_at desc);
  `);
  migrateLegacySessionEvents(db);
}

/** Upgrade the original single-room `(seq primary key, body)` table in place. */
function migrateLegacySessionEvents(db) {
  const columns = () => db.prepare("pragma table_info(session_event)").all();
  if (columns().some((column) => column.name === "room_id")) return;

  db.exec("begin immediate");
  try {
    // Another process may have completed the one-time migration while this one
    // waited for the write lock.
    if (columns().some((column) => column.name === "room_id")) {
      db.exec("commit");
      return;
    }
    const rows = db.prepare("select seq, body from session_event order by seq asc").all();
    db.exec(`
      alter table session_event rename to session_event_legacy;
      create table session_event (
        room_id text not null default '',
        seq integer not null,
        body text not null,
        primary key (room_id, seq)
      );
    `);
    const insert = db.prepare("insert into session_event (room_id, seq, body) values (?, ?, ?)");
    for (const row of rows) {
      let roomId = "";
      try {
        roomId = String(JSON.parse(row.body)?.room_id ?? "");
      } catch {
        // Preserve corrupt legacy evidence under the legacy room rather than
        // rewriting or dropping bytes during a schema migration.
      }
      insert.run(roomId, row.seq, row.body);
    }
    db.exec("drop table session_event_legacy; commit");
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
}

/**
 * The Session Event Log.
 *
 * Append-only and gap-checked exactly as the in-memory port is: a log with a
 * hole in it cannot be verified, and the verification is the whole point.
 */
export class SqliteEventStore {
  constructor(db, roomId = null) {
    this.db = db;
    this.roomId = roomId === null ? null : String(roomId);
    this._tipAny = db.prepare("select body from session_event order by rowid desc limit 1");
    this._tipRoom = db.prepare("select body from session_event where room_id = ? order by seq desc limit 1");
    this._insert = db.prepare("insert into session_event (room_id, seq, body) values (?, ?, ?)");
    this._allAny = db.prepare("select body from session_event order by rowid asc");
    this._allRoom = db.prepare("select body from session_event where room_id = ? order by seq asc");
    this._sliceAny = db.prepare("select body from session_event where seq >= ? and seq <= ? order by rowid asc");
    this._sliceRoom = db.prepare("select body from session_event where room_id = ? and seq >= ? and seq <= ? order by seq asc");
  }

  // Async throughout, though the driver is not — see SqliteKeyValue above.
  // This class in particular was missed by ce87674: the event log is the
  // evidence a resolver reconstructs from, so a caller that forgot to await
  // a genuinely-async backend here would not just render wrong, it would
  // resolve a market on a gap or a duplicate nothing caught.

  async tip() {
    const row = this.roomId === null ? this._tipAny.get() : this._tipRoom.get(this.roomId);
    return row ? JSON.parse(row.body) : null;
  }

  async append(event) {
    const eventRoom = String(event?.room_id ?? "");
    if (this.roomId !== null && eventRoom && eventRoom !== this.roomId) {
      throw new Error(`event belongs to room ${eventRoom}, not ${this.roomId}`);
    }
    const roomId = this.roomId ?? eventRoom;
    const normalized = this.roomId !== null && !eventRoom ? { ...event, room_id: this.roomId } : event;
    const row = this._tipRoom.get(roomId);
    const tip = row ? JSON.parse(row.body) : null;
    const expected = tip ? tip.seq + 1 : 1;
    if (event.seq !== expected) throw new Error(`append gap: got ${event.seq}, expected ${expected}`);
    this._insert.run(roomId, event.seq, JSON.stringify(normalized));
  }

  async all() {
    const rows = this.roomId === null ? this._allAny.all() : this._allRoom.all(this.roomId);
    return rows.map((row) => JSON.parse(row.body));
  }

  async slice(fromSeq, toSeq = Number.MAX_SAFE_INTEGER) {
    const last = Math.min(toSeq, Number.MAX_SAFE_INTEGER);
    const rows =
      this.roomId === null
        ? this._sliceAny.all(fromSeq, last)
        : this._sliceRoom.all(this.roomId, fromSeq, last);
    return rows.map((row) => JSON.parse(row.body));
  }

  /** A view whose sequence, tip and reads belong to exactly one room. */
  forRoom(roomId) {
    return new SqliteEventStore(this.db, roomId);
  }
}

/** The bytes the event log's hashes commit to. */
export class SqliteRawArchive {
  constructor(db) {
    this.db = db;
    this._put = db.prepare("insert or replace into raw_blob (ref, bytes) values (?, ?)");
    this._get = db.prepare("select bytes from raw_blob where ref = ?");
  }

  async put(id, bytes) {
    const ref = `sqlite://raw/${id}`;
    this._put.run(ref, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    return ref;
  }

  async get(ref) {
    const row = this._get.get(ref);
    return row ? Buffer.from(row.bytes) : null;
  }
}

/** Small durable state — gate nonces, cursors, anything a restart must resume. */
export class SqliteKeyValue {
  constructor(db) {
    this.db = db;
    this._get = db.prepare("select value from kv where key = ?");
    this._set = db.prepare("insert or replace into kv (key, value) values (?, ?)");
  }

  /**
   * Async, though the driver underneath is not.
   *
   * The port is async because the general case is — a durable store reached over
   * a socket cannot be synchronous — and because a port that is sync under one
   * adapter and async under another has a failure mode nothing catches: a missed
   * `await` does not throw, it yields a Promise, and a Promise is always truthy.
   * `if (state.get("suspended"))` would then be permanently true. Making both
   * adapters async means every missed await fails loudly in the existing suite
   * rather than silently in a gate deciding whether to close a room.
   */
  async get(key, fallback = null) {
    const row = this._get.get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  async set(key, value) {
    this._set.run(key, JSON.stringify(value));
  }
}

/**
 * Per-room leader election over a lease with a bounded lifetime.
 *
 * One replica may hold a room's lease at a time; another may take it over
 * once it expires unrenewed. That is the whole primitive — renewal cadence,
 * who renews, and what a leader is for are all the caller's business.
 *
 * The acquire-or-renew-or-refuse decision has to be one atomic statement,
 * not a read then a write two replicas could interleave between. SQLite's
 * upsert supports a `WHERE` on the `DO UPDATE` branch, which is exactly the
 * "only if expired, or it's already me" condition this needs.
 */
export class SqliteLeaderLease {
  constructor(db) {
    this._tryAcquire = db.prepare(`
      insert into leader_lease (room_id, holder, expires_at, term)
      values (?, ?, ?, 1)
      on conflict(room_id) do update set
        holder = excluded.holder,
        expires_at = excluded.expires_at,
        term = leader_lease.term + case when leader_lease.holder = excluded.holder then 0 else 1 end
      where leader_lease.expires_at <= ? or leader_lease.holder = excluded.holder
      returning term, expires_at
    `);
  }

  /** Acquires or renews the lease for `roomId`; null when another holder still owns it. */
  async tryAcquire(roomId, holder, ttlMs, now = Date.now()) {
    const row = this._tryAcquire.get(String(roomId), holder, now + ttlMs, now);
    return row ? { holder, term: Number(row.term), expiresAt: Number(row.expires_at) } : null;
  }
}

// What an erased account's own words and identity become. Never the empty
// string: an empty `author` reads as a bug (something failed to record who
// posted), where this reads as what it is — a deliberate redaction.
const ERASED = "[erased]";
const ERASED_TEXT = "[removed by the account holder]";

/**
 * Chat, its moderation and its audit trail.
 *
 * Message ids come from the table's own sequence rather than an array length,
 * so they keep climbing across restarts: a moderation signed over message 5
 * cannot be replayed onto a different message 5 tomorrow.
 */
export class SqliteChatStore {
  /**
   * @param roomId scopes every message, timeout and audit line to one room.
   *
   * One process can serve several rooms; a message posted in one must not
   * appear in another, and being muted in one is not being muted everywhere.
   * Message ids stay globally monotonic so a moderation signed over id 5 can
   * never land on a different message 5 in another room or after a restart.
   */
  constructor(db, roomId = "") {
    this.db = db;
    this.roomId = roomId;
    this._append = db.prepare("insert into chat_message (room_id, author, label, text, at) values (?, ?, ?, ?, ?)");
    this._lastId = db.prepare("select last_insert_rowid() as id");
    this._history = db.prepare(
      "select * from chat_message where room_id = ? and id > ? and deleted = 0 order by id asc"
    );
    this._find = db.prepare("select * from chat_message where room_id = ? and id = ?");
    this._delete = db.prepare("update chat_message set deleted = 1 where room_id = ? and id = ?");
    this._setTimeout = db.prepare("insert or replace into chat_timeout (room_id, account, until) values (?, ?, ?)");
    this._timeout = db.prepare("select until from chat_timeout where room_id = ? and account = ?");
    this._pruneTimeouts = db.prepare("delete from chat_timeout where room_id = ? and until <= ?");
    this._audit = db.prepare(
      "insert into chat_audit (room_id, moderator, action, message_id, at) values (?, ?, ?, ?, ?)"
    );
    this._auditAll = db.prepare("select * from chat_audit where room_id = ? order by id asc");
    this._trim = db.prepare(
      "delete from chat_message where room_id = ?1 and id <= (select id from chat_message where room_id = ?1 order by id desc limit 1 offset ?2)"
    );
    this._eraseMessages = db.prepare(
      "update chat_message set author = ?, text = ? where lower(author) = ? returning id"
    );
    this._eraseTimeouts = db.prepare("delete from chat_timeout where account = ? returning room_id");
  }

  /** The same file, scoped to another room. */
  forRoom(roomId) {
    return new SqliteChatStore(this.db, roomId);
  }

  // Async, though the driver underneath is not — see SqliteKeyValue above for
  // why: a port that is sync on one adapter and async on another has a
  // missed-await failure mode nothing catches, because a Promise is always
  // truthy and a caller that forgets to await one gets away with it exactly
  // until the backend underneath happens to be genuinely asynchronous. This
  // whole class was missed by that conversion — found via the Postgres
  // wiring, where `ChatService.history()` not being awaited by a caller
  // stopped being harmless and instead hung service.stop() waiting on a
  // dangling query nothing was driving forward.

  async append({ author, label = null, text, at }) {
    this._append.run(this.roomId, author, label, text, at);
    const id = Number(this._lastId.get().id);
    return { id, author, label, text, at, presentation_only: true };
  }

  async history(sinceId = 0) {
    return this._history.all(this.roomId, sinceId).map((row) => ({
      id: Number(row.id),
      author: row.author,
      label: row.label,
      text: row.text,
      at: row.at,
      presentation_only: true,
    }));
  }

  async find(id) {
    const row = this._find.get(this.roomId, id);
    return row ? { id: Number(row.id), author: row.author, text: row.text, at: row.at } : null;
  }

  async delete(id) {
    this._delete.run(this.roomId, id);
  }

  async setTimeout(account, untilMs) {
    this._setTimeout.run(this.roomId, String(account).toLowerCase(), Math.floor(untilMs));
  }

  async timeoutFor(account) {
    const row = this._timeout.get(this.roomId, String(account).toLowerCase());
    return row ? Number(row.until) : 0;
  }

  async audit(entry) {
    this._audit.run(this.roomId, entry.moderator, entry.action, entry.messageId ?? null, entry.at);
  }

  async auditLog() {
    return this._auditAll.all(this.roomId).map((row) => ({
      moderator: row.moderator,
      action: row.action,
      messageId: row.message_id === null ? null : Number(row.message_id),
      at: row.at,
    }));
  }

  /** Bounds retained history and releases expired timeouts. */
  async prune({ nowMs, maxMessages }) {
    this._pruneTimeouts.run(this.roomId, Math.floor(nowMs));
    if (Number.isFinite(maxMessages) && maxMessages > 0) this._trim.run(this.roomId, maxMessages - 1);
  }

  /**
   * Removes one account's authorship from every room, not just this one.
   *
   * Every other method here is scoped to `this.roomId`, because that is what
   * a room's readers and moderators need. Erasure asks a different question —
   * "get my words out of this deployment," not "out of whichever room this
   * store instance happens to be attached to" — so this reaches across all
   * rooms directly rather than making the caller enumerate them.
   *
   * The row and its id stay: another author's reply to it, and the room's
   * message ordering, are not this account's data to take with them.
   */
  async eraseAccount(account) {
    const key = String(account).toLowerCase();
    const messages = this._eraseMessages.all(ERASED, ERASED_TEXT, key);
    const timeouts = this._eraseTimeouts.all(key);
    return { messagesErased: messages.length, timeoutsCleared: timeouts.length };
  }
}

/**
 * Referral bindings.
 *
 * One row per referred account, never more: a second binding would let someone
 * shop for a referrer after the fact. The block is what makes attribution
 * checkable — a first market action *before* the binding is a retro-claim on
 * somebody who was already here, not a referral.
 */
export class SqliteReferralStore {
  constructor(db) {
    this.db = db;
    this._bind = db.prepare(
      "insert into referral_binding (account, code, referrer, bound_at_block, bound_at) values (?, ?, ?, ?, ?)"
    );
    this._get = db.prepare("select * from referral_binding where account = ?");
    this._byReferrer = db.prepare("select * from referral_binding where referrer = ?");
    this._eraseOwn = db.prepare("delete from referral_binding where account = ? returning account");
    this._redactReferrer = db.prepare("update referral_binding set referrer = ? where referrer = ? returning account");
  }

  async bind({ account, code, referrer, atBlock = null, at = new Date().toISOString() }) {
    this._bind.run(String(account).toLowerCase(), code, String(referrer).toLowerCase(), atBlock, at);
  }

  async bindingFor(account) {
    const row = this._get.get(String(account).toLowerCase());
    return row
      ? { account: row.account, code: row.code, referrer: row.referrer, boundAtBlock: row.bound_at_block, boundAt: row.bound_at }
      : null;
  }

  async bindingsBy(referrer) {
    return this._byReferrer.all(String(referrer).toLowerCase()).map((row) => ({
      account: row.account,
      code: row.code,
      referrer: row.referrer,
      boundAtBlock: row.bound_at_block,
      boundAt: row.bound_at,
    }));
  }

  /**
   * Removes an account's own binding, and redacts (does not delete) its
   * appearance as someone else's referrer.
   *
   * A binding where this account was REFERRED is entirely its own record. A
   * binding where it was the REFERRER belongs to the person who was referred
   * — that row (that someone was referred, and when) is theirs, not the
   * erased account's, so only the `referrer` column is redacted.
   */
  async eraseAccount(account) {
    const key = String(account).toLowerCase();
    const own = this._eraseOwn.all(key);
    const asReferrer = this._redactReferrer.all(ERASED, key);
    return { ownBindingDeleted: own.length > 0, referredBindingsRedacted: asReferrer.length };
  }
}

/** Who accepted which terms version, and whether they proved it. */
export class SqliteAcceptanceStore {
  constructor(db) {
    this.db = db;
    this._get = db.prepare("select version, proven from terms_acceptance where account = ?");
    this._set = db.prepare(`
      insert into terms_acceptance (account, version) values (?, ?)
      on conflict(account) do update set version = excluded.version
    `);
    this._setProven = db.prepare("update terms_acceptance set proven = ? where account = ?");
    this._erase = db.prepare("delete from terms_acceptance where account = ? returning account");
  }

  async get(account) {
    const row = this._get.get(String(account).toLowerCase());
    return row ? row.version : undefined;
  }

  async set(account, version) {
    this._set.run(String(account).toLowerCase(), version);
  }

  async proven(account) {
    const row = this._get.get(String(account).toLowerCase());
    return row ? Boolean(row.proven) : false;
  }

  async setProven(account, proven) {
    this._setProven.run(proven ? 1 : 0, String(account).toLowerCase());
  }

  /**
   * Deletes the acceptance record outright.
   *
   * Unlike chat or referrals there is nothing here that belongs to someone
   * else to preserve — but see docs/runbooks/DATA_PRIVACY_AND_RETENTION.md:
   * whether deleting a signed proof-of-consent record on that same person's
   * request is the right default, versus retaining a proof-only stub, is an
   * open legal question this method does not resolve. It only builds the
   * mechanical capability.
   */
  async eraseAccount(account) {
    const deleted = this._erase.all(String(account).toLowerCase());
    return { deleted: deleted.length > 0 };
  }
}

/**
 * What one resolver has attested, and what it refused to.
 *
 * A resolver runs as its own process against its own key, and the market
 * rejects a second attestation from the same signer. A resolver that forgets
 * therefore does not double-attest — it spends a transaction every tick,
 * forever, to be told it already did. Worse, its refusals disappear: a market
 * this operator will not attest is an incident somebody has to see, and
 * without a record the only symptom is a market that never reaches quorum.
 *
 * Scoped by resolver address as well as room, because three independent
 * operators may share nothing but the chain — and where they do share a data
 * directory, one operator's record must never be read as another's.
 */
export class SqliteResolutionLog {
  constructor(db, roomId = "", resolver = "") {
    this.db = db;
    this.roomId = roomId;
    this.resolver = String(resolver).toLowerCase();
    this._put = db.prepare(`
      insert into resolution_attempt (room_id, market, resolver, status, outcome, evidence_hash, reason, at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(room_id, market, resolver) do update set
        status = excluded.status, outcome = excluded.outcome,
        evidence_hash = excluded.evidence_hash, reason = excluded.reason, at = excluded.at
    `);
    this._get = db.prepare("select * from resolution_attempt where room_id = ? and market = ? and resolver = ?");
    this._all = db.prepare("select * from resolution_attempt where room_id = ? and resolver = ? order by at asc");
    this._putVerdict = db.prepare(`
      insert into challenge_verdict (room_id, market, resolver, accepted, outcome, reason, at)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(room_id, market, resolver) do nothing
    `);
    this._getVerdict = db.prepare("select * from challenge_verdict where room_id = ? and market = ? and resolver = ?");
  }

  /**
   * Records this resolver's vote on a bonded challenge.
   *
   * `do nothing` on conflict, not `do update`: a resolver votes once. The market
   * rejects a second verdict from the same signer anyway, so a row that could be
   * overwritten would only ever mislead the operator reading it back.
   */
  async recordVerdict(market, { accepted, outcome = null, reason = null, at = new Date().toISOString() }) {
    this._putVerdict.run(
      this.roomId,
      String(market).toLowerCase(),
      this.resolver,
      accepted ? 1 : 0,
      outcome === null ? null : Number(outcome),
      reason,
      at
    );
  }

  /** This resolver's vote on a market's challenge, or null if it has not voted. */
  async verdict(market) {
    const row = this._getVerdict.get(this.roomId, String(market).toLowerCase(), this.resolver);
    return row
      ? { market: row.market, accepted: row.accepted === 1, outcome: row.outcome, reason: row.reason, at: row.at }
      : null;
  }

  async record(market, { status, outcome = null, evidenceHash = null, reason = null, at = new Date().toISOString() }) {
    this._put.run(
      this.roomId,
      String(market).toLowerCase(),
      this.resolver,
      status,
      outcome === null ? null : Number(outcome),
      evidenceHash,
      reason,
      at
    );
  }

  async get(market) {
    const row = this._get.get(this.roomId, String(market).toLowerCase(), this.resolver);
    return row
      ? {
          market: row.market,
          resolver: row.resolver,
          status: row.status,
          outcome: row.outcome === null ? null : Number(row.outcome),
          evidenceHash: row.evidence_hash,
          reason: row.reason,
          at: row.at,
        }
      : null;
  }

  /** Whether THIS resolver has already put its signature behind a result. */
  async attested(market) {
    return (await this.get(market))?.status === "attested";
  }

  async all() {
    return this._all.all(this.roomId, this.resolver).map((row) => ({
      market: row.market,
      status: row.status,
      outcome: row.outcome === null ? null : Number(row.outcome),
      evidenceHash: row.evidence_hash,
      reason: row.reason,
      at: row.at,
    }));
  }
}

/** Durable metadata and file references for livestream evidence bundles. */
export class SqliteOracleProofStore {
  constructor(db) {
    this.db = db;
    this._put = db.prepare(`
      insert into livestream_oracle_proof (
        id, market, outcome, stream_url, occurred_at, clip_start_ms,
        clip_end_ms, rule, rationale, clip_sha256, evidence_hash,
        canonical_json, video_path, byte_length, mime_type, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._byId = db.prepare("select * from livestream_oracle_proof where id = ?");
    this._byHash = db.prepare("select * from livestream_oracle_proof where evidence_hash = ?");
    this._latest = db.prepare(`
      select * from livestream_oracle_proof
      where market = ?
      order by created_at desc, rowid desc
      limit 1
    `);
    this._putChallenge = db.prepare(`
      insert into livestream_challenge_evidence (
        evidence_hash, market, evidence, transaction_hash, challenger, created_at
      ) values (?, ?, ?, ?, ?, ?)
    `);
    this._challengeByHash = db.prepare("select * from livestream_challenge_evidence where evidence_hash = ?");
    this._latestChallenge = db.prepare(`
      select * from livestream_challenge_evidence
      where market = ?
      order by created_at desc, rowid desc
      limit 1
    `);
  }

  async put(record) {
    this._put.run(
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
      record.created_at
    );
    return this.byId(record.id);
  }

  async byId(id) {
    return normalizeOracleRow(this._byId.get(String(id)));
  }

  async byEvidenceHash(evidenceHash) {
    return normalizeOracleRow(this._byHash.get(String(evidenceHash).toLowerCase()));
  }

  async latestForMarket(market) {
    return normalizeOracleRow(this._latest.get(String(market).toLowerCase()));
  }

  async putChallenge(record) {
    this._putChallenge.run(
      record.evidence_hash,
      record.market,
      record.evidence,
      record.transaction_hash,
      record.challenger,
      record.created_at
    );
    return this.challengeByEvidenceHash(record.evidence_hash);
  }

  async challengeByEvidenceHash(evidenceHash) {
    return this._challengeByHash.get(String(evidenceHash).toLowerCase()) ?? null;
  }

  async latestChallengeForMarket(market) {
    return this._latestChallenge.get(String(market).toLowerCase()) ?? null;
  }
}

function normalizeOracleRow(row) {
  if (!row) return null;
  return {
    ...row,
    outcome: Number(row.outcome),
    clip_start_ms: Number(row.clip_start_ms),
    clip_end_ms: Number(row.clip_end_ms),
    byte_length: Number(row.byte_length),
  };
}
