// The durable publication request channel.
//
// Publishing a market needs two authorities that must not be one process: the
// Gate signs a permit with GATE_SIGNER_ROLE, the Publisher submits it with
// PROGRAM_PUBLISHER_ROLE. Two processes need somewhere to hand work to each
// other, and that somewhere has to survive a restart of either of them —
// otherwise "the publisher was restarted" silently means "the question you
// queued is gone", which from outside is indistinguishable from a question
// nobody ever asked.
//
// This is that place: one row per request, moving through a state machine that
// is written down before each step rather than after it.
//
//   queued ──publisher validates──▶ awaiting_permit ──gate signs──▶ permitted
//     │                                   │                            │
//     ▼                                   ▼                            ▼
//   rejected                           refused                    published
//   (not in the catalogue)      (the gate said no, with        (or failed, with
//                                a reason — never retried       the revert reason)
//                                blindly)
//
// The channel is the shared SQLite file the operator processes already run on
// — the same file the event log, the raw archive and the gate's nonce counter
// live in. It is deliberately not a network service: a socket between the gate
// and the publisher would be one more thing to authenticate, and it would not
// make the queue durable, which is the property that actually matters here.
// The cost is honest and worth naming: gate and publisher must share a
// filesystem, so this composition is one host (or one shared volume), not two
// datacentres.

/** BigInt survives the round trip; a permit is mostly BigInts. */
function encode(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? { $bigint: item.toString() } : item
  );
}

function decode(text) {
  if (text === null || text === undefined) return null;
  return JSON.parse(text, (_key, item) =>
    item && typeof item === "object" && typeof item.$bigint === "string" ? BigInt(item.$bigint) : item
  );
}

export const PUBLICATION_STATUSES = [
  "queued",
  "awaiting_permit",
  "permitted",
  "published",
  "rejected",
  "refused",
  "failed",
];

/** The statuses a request can still move out of. */
export const PUBLICATION_OPEN_STATUSES = ["queued", "awaiting_permit", "permitted"];

export class SqlitePublicationQueue {
  /**
   * @param db      an open room database
   * @param roomId  requests are scoped to a room: one process can serve several,
   *                and a question queued for one must never publish into another
   */
  constructor(db, roomId = "") {
    this.db = db;
    this.roomId = roomId;
    this._insert = db.prepare(`
      insert into publication_request (room_id, status, candidate, submitted_at, updated_at)
      values (?, 'queued', ?, ?, ?)
    `);
    this._lastId = db.prepare("select last_insert_rowid() as id");
    this._get = db.prepare("select * from publication_request where id = ?");
    this._byStatus = db.prepare(
      "select * from publication_request where room_id = ? and status = ? order by id asc"
    );
    this._open = db.prepare(`
      select * from publication_request
      where room_id = ? and status in ('queued', 'awaiting_permit', 'permitted')
      order by id asc
    `);
    this._all = db.prepare("select * from publication_request where room_id = ? order by id asc");
    this._publishedMarket = db.prepare(`
      select * from publication_request
      where room_id = ? and status = 'published' and lower(market) = lower(?)
      order by id desc limit 1
    `);
    this._update = db.prepare(`
      update publication_request
      set status = ?, request = ?, restricted = ?, condition_doc = ?, permit = ?, signature = ?,
          market = ?, reason = ?, attempts = ?, updated_at = ?
      where id = ?
    `);
  }

  _row(row) {
    if (!row) return null;
    return {
      id: row.id,
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

  // Async throughout, though the driver is not — see SqliteKeyValue in
  // sqlite-stores.mjs for why. Missed by that conversion entirely: this is
  // the gate-publisher IPC channel, a money path, and every call here was
  // still a plain synchronous return until this pass.

  /** Accepts a question. Durable from here; nothing else has happened yet. */
  async submit(candidate, at = new Date().toISOString()) {
    this._insert.run(this.roomId, encode(candidate), at, at);
    const id = Number(this._lastId.get().id);
    return { id, status: "queued" };
  }

  async get(id) {
    return this._row(this._get.get(id));
  }

  async byStatus(status) {
    return this._byStatus.all(this.roomId, status).map((row) => this._row(row));
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

  /** The durable frozen document for one published market in this room. */
  async conditionForMarket(market) {
    return this._row(this._publishedMarket.get(this.roomId, market));
  }

  /** Everything still in flight — what a restart has to pick back up. */
  async open() {
    return this._open.all(this.roomId).map((row) => this._row(row));
  }

  async all() {
    return this._all.all(this.roomId).map((row) => this._row(row));
  }

  /**
   * Writes one transition. Every field is carried forward unless the caller
   * names it, so a transition cannot quietly drop the condition document the
   * resolver will need or the permit the publisher is about to submit.
   */
  async _transition(id, status, patch = {}) {
    const current = await this.get(id);
    if (!current) throw new Error(`no publication request ${id}`);
    const next = { ...current, ...patch, status };
    this._update.run(
      status,
      next.request === null || next.request === undefined ? null : encode(next.request),
      encode(next.restricted ?? []),
      next.conditionDocument === null || next.conditionDocument === undefined
        ? null
        : encode(next.conditionDocument),
      next.permit === null || next.permit === undefined ? null : encode(next.permit),
      next.signature ?? null,
      next.market ?? null,
      next.reason ?? null,
      Number(next.attempts ?? 0),
      patch.updatedAt ?? new Date().toISOString(),
      id
    );
    return this.get(id);
  }

  /** Validated against the frozen catalogue; now it is the gate's turn. */
  async markAwaitingPermit(id, { request, restricted, conditionDocument }) {
    return this._transition(id, "awaiting_permit", {
      request,
      restricted,
      conditionDocument,
      permit: null,
      signature: null,
      reason: null,
    });
  }

  /** Not a question this room publishes. Terminal. */
  async markRejected(id, reason) {
    return this._transition(id, "rejected", { reason });
  }

  /** The gate signed. The permit is single-use and time-bounded. */
  async markPermitted(id, { permit, signature, request }) {
    return this._transition(id, "permitted", { permit, signature, request, reason: null });
  }

  /** The gate said no, and why. Terminal: never retried blindly. */
  async markRefused(id, reason) {
    return this._transition(id, "refused", { reason });
  }

  async markPublished(id, { market }) {
    return this._transition(id, "published", { market, reason: null });
  }

  /** A submission that reverted. Terminal after the caller gives up on it. */
  async markFailed(id, reason) {
    return this._transition(id, "failed", { reason });
  }

  /** Drops a dead permit and asks again, counting the attempt. */
  async reopenForPermit(id, reason) {
    const current = await this.get(id);
    return this._transition(id, "awaiting_permit", {
      permit: null,
      signature: null,
      reason,
      attempts: Number(current.attempts ?? 0) + 1,
    });
  }
}
