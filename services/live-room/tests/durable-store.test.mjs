// Durable non-chain history.
//
// The projections are disposable by design: drop them and they rebuild from
// chain logs. Everything else in this system cannot be rebuilt from anywhere —
// the Session Event Log and its hash chain, the raw provider bytes it commits
// to, chat and its moderation record, who accepted which terms version, and the
// Gate Authority's nonces. Holding those in memory means a restart silently
// erases the only copy.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  SqliteEventStore,
  SqliteRawArchive,
  SqliteKeyValue,
  SqliteChatStore,
  SqliteAcceptanceStore,
  openDatabase,
} from "../src/ports/sqlite-stores.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-durable-"));
  return { dir, path: join(dir, "room.db"), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the session event log survives a restart, hash chain intact", async () => {
  const { path, clean } = scratch();
  try {
    const first = new SqliteEventStore(openDatabase(path));
    await first.append({ seq: 1, kind: "baseline", prev_hash: null, hash: "0xa", observed_at: "2026-01-01T00:00:00.000Z" });
    await first.append({ seq: 2, kind: "fill", prev_hash: "0xa", hash: "0xb", observed_at: "2026-01-01T00:00:01.000Z" });
    assert.equal((await first.tip()).seq, 2);

    // A new process, the same file.
    const second = new SqliteEventStore(openDatabase(path));
    assert.equal((await second.tip()).seq, 2, "the log continues where it stopped");
    assert.equal((await second.tip()).hash, "0xb");
    assert.equal((await second.all()).length, 2);
    assert.deepEqual(
      (await second.all()).map((event) => event.prev_hash),
      [null, "0xa"],
      "the chain links survive verbatim"
    );

    // And the append gap check still holds across the restart.
    await assert.rejects(() => second.append({ seq: 2, kind: "fill" }), /gap/);
    await second.append({ seq: 3, kind: "fill", prev_hash: "0xb", hash: "0xc" });
    assert.equal((await second.slice(2, 3)).length, 2);
  } finally {
    clean();
  }
});

test("two rooms in one database each have an independent gap-free source sequence", async () => {
  const { path, clean } = scratch();
  try {
    const root = new SqliteEventStore(openDatabase(path));
    const alpha = root.forRoom("alpha");
    const beta = root.forRoom("beta");

    await alpha.append({ seq: 1, room_id: "alpha", kind: "baseline", hash: "0xa" });
    await beta.append({ seq: 1, room_id: "beta", kind: "baseline", hash: "0xb" });
    await alpha.append({ seq: 2, room_id: "alpha", kind: "fill", prev_hash: "0xa", hash: "0xc" });

    assert.deepEqual((await alpha.all()).map((event) => event.seq), [1, 2]);
    assert.deepEqual((await beta.all()).map((event) => event.seq), [1]);
    assert.equal((await alpha.tip()).room_id, "alpha");
    assert.equal((await beta.tip()).room_id, "beta");
  } finally {
    clean();
  }
});

test("the original single-room table upgrades without losing its evidence", async () => {
  const { path, clean } = scratch();
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("create table session_event (seq integer primary key, body text not null)");
    const event = { seq: 1, room_id: "alpha", kind: "baseline", hash: "0xa" };
    legacy.prepare("insert into session_event (seq, body) values (?, ?)").run(1, JSON.stringify(event));
    legacy.close();

    const database = openDatabase(path);
    const alpha = new SqliteEventStore(database).forRoom("alpha");
    assert.deepEqual(await alpha.all(), [event]);
    await alpha.append({ seq: 2, room_id: "alpha", kind: "fill", prev_hash: "0xa", hash: "0xb" });
    assert.equal((await alpha.tip()).seq, 2);
    database.close();
  } finally {
    clean();
  }
});

test("raw provider bytes survive, so a resolver can still reconstruct", async () => {
  const { path, clean } = scratch();
  try {
    const archive = new SqliteRawArchive(openDatabase(path));
    const ref = await archive.put("query-1", Buffer.from('{"accountValue":"10000"}'));

    const reopened = new SqliteRawArchive(openDatabase(path));
    assert.equal((await reopened.get(ref)).toString(), '{"accountValue":"10000"}');
    assert.equal(await reopened.get("mem://raw/nothing"), null, "a missing ref is null, not a throw");
  } finally {
    clean();
  }
});

test("chat, its moderation and its audit trail survive a restart", async () => {
  const { path, clean } = scratch();
  try {
    const store = new SqliteChatStore(openDatabase(path));
    const first = await store.append({ author: "0xA", label: null, text: "hello", at: "2026-01-01T00:00:00.000Z" });
    await store.append({ author: "0xB", label: "host", text: "welcome", at: "2026-01-01T00:00:01.000Z" });
    await store.delete(first.id, "0xMOD");
    await store.setTimeout("0xa", 9_999_999_999_999);
    await store.audit({ moderator: "0xMOD", action: "delete", messageId: first.id, at: "2026-01-01T00:00:02.000Z" });

    const reopened = new SqliteChatStore(openDatabase(path));
    const history = await reopened.history(0);
    assert.equal(history.length, 1, "a deleted message stays deleted after a restart");
    assert.equal(history[0].text, "welcome");
    assert.equal(
      await reopened.timeoutFor("0xa"),
      9_999_999_999_999,
      "a moderator's timeout is not a restart away from lifted"
    );
    assert.equal((await reopened.auditLog()).length, 1, "and the record of who did it survives");

    // Ids keep climbing, so a moderation signed over a message id cannot be
    // replayed onto a different message after a restart.
    const next = await reopened.append({ author: "0xC", text: "third", at: "2026-01-01T00:00:03.000Z" });
    assert.equal(next.id, 3);
  } finally {
    clean();
  }
});

test("terms acceptances and their proof survive a restart", async () => {
  const { path, clean } = scratch();
  try {
    const store = new SqliteAcceptanceStore(openDatabase(path));
    await store.set("0xa", "testnet-1");
    await store.setProven("0xa", true);
    await store.set("0xb", "testnet-1");

    const reopened = new SqliteAcceptanceStore(openDatabase(path));
    assert.equal(
      await reopened.get("0xa"),
      "testnet-1",
      "a person does not re-accept because the process restarted"
    );
    assert.equal(await reopened.proven("0xa"), true, "and a signature they gave is not forgotten");
    assert.equal(await reopened.proven("0xb"), false);
    assert.equal(await reopened.get("0xnobody"), undefined);
  } finally {
    clean();
  }
});

test("key-value state survives, so a restarted gate resumes rather than replays", async () => {
  const { path, clean } = scratch();
  try {
    const kv = new SqliteKeyValue(openDatabase(path));
    await kv.set("gate:nonce", { nonce: 5, audit: [{ slot: 1 }] });

    const reopened = new SqliteKeyValue(openDatabase(path));
    assert.deepEqual((await reopened.get("gate:nonce")).audit, [{ slot: 1 }]);
    assert.equal((await reopened.get("gate:nonce")).nonce, 5);
    assert.equal(await reopened.get("missing", "fallback"), "fallback");
  } finally {
    clean();
  }
});

test("the same file is safe to open twice, and closing one does not break the other", async () => {
  const { path, clean } = scratch();
  try {
    const a = new SqliteEventStore(openDatabase(path));
    await a.append({ seq: 1, kind: "baseline", hash: "0xa" });

    const b = new SqliteEventStore(openDatabase(path));
    await b.append({ seq: 2, kind: "fill", prev_hash: "0xa", hash: "0xb" });

    assert.equal((await a.tip()).seq, 2, "each connection reads what the other wrote");
  } finally {
    clean();
  }
});

test("five processes share the durable store without losing writes", async () => {
  // The runbook puts the gate, publisher, connector, resolver and Coordinator in
  // separate processes on one TM_DATA_DIR — that separation is the whole point:
  // one process must never hold two authority keys. What it means for the store
  // is five writers on one SQLite file.
  //
  // WAL allows one writer at a time, and without a busy timeout SQLite does not
  // wait for its turn: it fails immediately with "database is locked". Measured
  // at roughly two writes in five lost, silently, across the gate's permit nonce
  // counter and audit, the connector's cursors and its signed events, chat,
  // acceptances and referral bindings.
  //
  // The nonce is the one that stings: it is persisted BEFORE a permit is handed
  // out precisely so a crash cannot reissue it, and a write that fails there
  // undoes that guarantee.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "tm-contention-"));
  const writer = join(dir, "writer.mjs");
  writeFileSync(
    writer,
    `import { openDatabase, SqliteKeyValue } from ${JSON.stringify(join(here, "..", "src", "ports", "sqlite-stores.mjs"))};
const [path, role] = process.argv.slice(2);
let errors = 0, writes = 0, reason = "";
for (let i = 0; i < 120; i++) {
  try {
    const db = openDatabase(path);
    new SqliteKeyValue(db).set(\`operator:\${role}:tick:\${i}\`, Date.now());
    db.close();
    writes++;
  } catch (error) {
    errors++;
    reason ||= error.message;
  }
}
process.stdout.write(JSON.stringify({ role, writes, errors, reason }));
`
  );

  const run = promisify(execFile);
  const roles = ["gate", "publisher", "connector", "resolver", "api"];
  try {
    const results = await Promise.all(
      roles.map((role) =>
        run("node", ["--no-warnings", writer, join(dir, "room.db"), role]).then((out) => JSON.parse(out.stdout))
      )
    );
    const failed = results.filter((entry) => entry.errors > 0);
    assert.deepEqual(
      failed,
      [],
      `writes were lost to contention: ${failed.map((entry) => `${entry.role} lost ${entry.errors} (${entry.reason})`).join("; ")}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("five processes can open the durable store at once without one failing to start", async () => {
  // Worse than a lost write: a process that never starts.
  //
  // Switching the journal mode takes an EXCLUSIVE lock and does not honour the
  // busy timeout — even READING the mode is refused while another process holds
  // it. So an operator opening the file while a neighbour was writing threw
  // "database is locked" during open, before it had done anything at all. Under
  // a supervisor that restarts always, that is a crash loop for as long as the
  // neighbour keeps writing.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "tm-open-race-"));
  const opener = join(dir, "opener.mjs");
  writeFileSync(
    opener,
    `import { openDatabase, SqliteKeyValue } from ${JSON.stringify(join(here, "..", "src", "ports", "sqlite-stores.mjs"))};
const [path, role] = process.argv.slice(2);
const db = openDatabase(path);
const kv = new SqliteKeyValue(db);
for (let i = 0; i < 200; i++) await kv.set(\`\${role}:\${i}\`, Date.now());
db.close();
process.stdout.write(JSON.stringify({ role, ok: true }));
`
  );

  const run = promisify(execFile);
  try {
    // A fresh file, so every process races to put it in WAL mode at once.
    const results = await Promise.all(
      ["gate", "publisher", "connector", "resolver", "api"].map((role) =>
        run("node", ["--no-warnings", opener, join(dir, "room.db"), role])
          .then((out) => JSON.parse(out.stdout))
          .catch((error) => ({ role, ok: false, reason: String(error.stderr ?? error).split("\n")[0] }))
      )
    );
    const failed = results.filter((entry) => !entry.ok);
    assert.deepEqual(failed, [], `processes failed to start: ${JSON.stringify(failed)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
