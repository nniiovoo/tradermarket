// Storage ports with in-memory and file-backed (JSONL) adapters.
// The file adapter is the deterministic local/game-day path; a PostgreSQL
// adapter can implement the same interface behind the read-model tier.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** EventStore port: append-only Session Event Log storage for one room. */
export class MemoryEventStore {
  constructor(events = null, roomId = null, persist = null) {
    this.events = events ?? [];
    this.roomId = roomId;
    this.persist = persist;
  }

  _roomOf(event) {
    return String(event?.room_id ?? "");
  }

  _visible() {
    if (this.roomId === null) return this.events;
    return this.events.filter((event) => this._roomOf(event) === this.roomId);
  }

  tip() {
    return this._visible().at(-1) ?? null;
  }

  append(event) {
    const eventRoom = this._roomOf(event);
    if (this.roomId !== null && eventRoom && eventRoom !== this.roomId) {
      throw new Error(`event belongs to room ${eventRoom}, not ${this.roomId}`);
    }
    const room = this.roomId ?? eventRoom;
    const normalized = this.roomId !== null && !eventRoom ? { ...event, room_id: this.roomId } : event;
    const tip = this.events.filter((entry) => this._roomOf(entry) === room).at(-1) ?? null;
    const expected = tip ? tip.seq + 1 : 1;
    if (event.seq !== expected) throw new Error(`append gap: got ${event.seq}, expected ${expected}`);
    this.events.push(normalized);
    this.persist?.(normalized);
  }

  all() {
    return [...this._visible()];
  }

  slice(fromSeq, toSeq = Number.POSITIVE_INFINITY) {
    return this._visible().filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
  }

  count() {
    return this._visible().length;
  }

  /** A view whose sequence, tip and reads belong to exactly one room. */
  forRoom(roomId) {
    return new MemoryEventStore(this.events, String(roomId), this.persist);
  }
}

export class FileEventStore extends MemoryEventStore {
  constructor(path) {
    super();
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim()) this.events.push(JSON.parse(line));
      }
    }
    this.persist = (event) => appendFileSync(this.path, JSON.stringify(event) + "\n");
  }
}

/** RawArchive port: the exact original provider bytes behind every event. */
export class MemoryRawArchive {
  constructor() {
    this.blobs = new Map();
  }

  put(id, bytes) {
    const ref = `mem://raw/${id}`;
    this.blobs.set(ref, bytes);
    return ref;
  }

  get(ref) {
    const bytes = this.blobs.get(ref);
    if (bytes === undefined) throw new Error(`missing raw blob ${ref}`);
    return bytes;
  }
}

export class FileRawArchive {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  put(id, bytes) {
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(this.dir, `${safe}.json`);
    writeFileSync(path, bytes);
    return `file://${path}`;
  }

  get(ref) {
    if (!ref.startsWith("file://")) throw new Error(`not a file ref: ${ref}`);
    return readFileSync(ref.slice("file://".length), "utf8");
  }
}

/** Small durable key-value cursor store (gate cursors, dedupe sets). */
export class FileKeyValue {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  get(key, fallback = null) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

export class MemoryKeyValue {
  constructor() {
    this.data = new Map();
  }

  get(key, fallback = null) {
    return this.data.has(key) ? this.data.get(key) : fallback;
  }

  set(key, value) {
    this.data.set(key, value);
  }
}

/**
 * In-memory leader lease. Same holder/expiry/term contract as the durable
 * adapters — there is only ever one process sharing this Map, so it never
 * actually contends, but it stays honest about the interface rather than
 * granting leadership unconditionally.
 */
export class MemoryLeaderLease {
  constructor() {
    this.leases = new Map();
  }

  tryAcquire(roomId, holder, ttlMs, now = Date.now()) {
    const key = String(roomId);
    const current = this.leases.get(key);
    if (current && current.holder !== holder && current.expiresAt > now) return null;
    const term = current ? current.term + (current.holder === holder ? 0 : 1) : 1;
    const lease = { holder, term, expiresAt: now + ttlMs };
    this.leases.set(key, lease);
    return { ...lease };
  }
}
