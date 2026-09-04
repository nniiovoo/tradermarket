// The durable-store port contract.
//
// Every adapter must pass this, unchanged. It is the definition of the port: if
// a behaviour is not asserted here, no adapter is obliged to have it, and
// nothing above the port may rely on it.
//
// It exists because Phase 1 adds a second adapter. The way a second adapter goes
// wrong is never "it does not compile" — it is a subtly different answer to a
// question nobody wrote down: an upsert that replaces instead of ignoring, a
// sequence that is global instead of per-room, a missing key that returns
// undefined instead of the caller's fallback. Each of those passes a unit test
// written against one implementation and corrupts a room served by the other.
//
// Every call is awaited. SQLite's driver is synchronous and PostgreSQL's is not,
// and `await` on a plain value is a plain value — so awaiting throughout is what
// lets one contract describe both without encoding either driver's shape into
// the port. That the port was synchronous at all was a SQLite detail that had
// leaked into the domain.

import assert from "node:assert/strict";

/**
 * Asserts a call fails, whether the adapter throws or rejects.
 *
 * Which one it does is the adapter's business, not the caller's.
 */
async function expectFailure(fn, match, message) {
  let error = null;
  let failed = false;
  try {
    await fn();
  } catch (caught) {
    failed = true;
    error = caught;
  }
  assert.ok(failed, message ?? "the call must fail");
  if (match) assert.match(String(error?.message ?? error), match, message);
}

/**
 * Runs the full contract against one adapter.
 *
 * @param options.test the node:test `test` function
 * @param options.name adapter name, used in test titles
 * @param options.open async () => ({ …stores, close() }) — a FRESH empty store set
 */
export function runStoreContract({ test, name, open }) {
  const scoped = (title, body) =>
    test(`[${name}] ${title}`, async (t) => {
      const ctx = await open();
      t.after(() => ctx.close?.());
      await body(ctx);
    });

  // ------------------------------------------------------------- event log
  scoped("the event log rejects a gap rather than storing one", async ({ eventLog }) => {
    const log = eventLog.forRoom("room-1");
    await log.append({ room_id: "room-1", seq: 1, type: "heartbeat", observed_at: "t1" });
    // The log is the evidence a resolver reconstructs from. A gap accepted here
    // is a hole in that evidence nothing downstream can detect.
    await expectFailure(
      () => log.append({ room_id: "room-1", seq: 3, type: "heartbeat", observed_at: "t3" }),
      /gap/i,
      "a sequence gap must be refused at the store, not repaired later"
    );
  });

  scoped("sequences are per room, not global", async ({ eventLog }) => {
    // Two rooms each start at 1. A global sequence would make room B's first
    // event seq 2, and every hash chain and evidence bundle would then disagree
    // with what the gate signed.
    await eventLog.forRoom("room-a").append({ room_id: "room-a", seq: 1, type: "heartbeat", observed_at: "t1" });
    await eventLog.forRoom("room-b").append({ room_id: "room-b", seq: 1, type: "heartbeat", observed_at: "t2" });

    const tipA = await eventLog.forRoom("room-a").tip();
    const tipB = await eventLog.forRoom("room-b").tip();
    assert.equal(tipA.seq, 1);
    assert.equal(tipB.seq, 1);

    const allA = await eventLog.forRoom("room-a").all();
    assert.equal(allA.length, 1, "one room's log must not contain another's events");
  });

  scoped("a room view refuses an event belonging to another room", async ({ eventLog }) => {
    await expectFailure(
      () => eventLog.forRoom("room-a").append({ room_id: "room-b", seq: 1, type: "heartbeat", observed_at: "t" }),
      /room/i
    );
  });

  scoped("slice is inclusive at both ends and ordered", async ({ eventLog }) => {
    const log = eventLog.forRoom("room-1");
    for (let seq = 1; seq <= 5; seq += 1) {
      await log.append({ room_id: "room-1", seq, type: "heartbeat", observed_at: `t${seq}` });
    }
    const window = await log.slice(2, 4);
    assert.deepEqual(window.map((event) => event.seq), [2, 3, 4], "slice bounds are inclusive");

    const everything = await log.all();
    assert.deepEqual(everything.map((event) => event.seq), [1, 2, 3, 4, 5], "and ordered by sequence");
  });

  scoped("an empty room has no tip, rather than a zero one", async ({ eventLog }) => {
    assert.equal(await eventLog.forRoom("empty").tip(), null);
    assert.deepEqual(await eventLog.forRoom("empty").all(), []);
  });

  // ----------------------------------------------------------- raw archive
  scoped("raw bytes round-trip exactly", async ({ rawArchive }) => {
    // These are the provider's own bytes, which the event log's hashes commit
    // to. A byte changed in storage invalidates every hash over it.
    const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d]);
    const ref = await rawArchive.put("blob-1", bytes);
    assert.ok(typeof ref === "string" && ref.length > 0, "put returns a reference");
    assert.deepEqual(await rawArchive.get(ref), bytes, "including bytes a text encoding would mangle");
  });

  scoped("putting the same id twice is idempotent, not a duplicate", async ({ rawArchive }) => {
    const first = await rawArchive.put("blob-1", Buffer.from("one"));
    const second = await rawArchive.put("blob-1", Buffer.from("one"));
    assert.equal(first, second, "the same id yields the same ref");
    assert.deepEqual(await rawArchive.get(first), Buffer.from("one"));
  });

  scoped("an unknown reference is null, never a throw or an empty buffer", async ({ rawArchive }) => {
    // A resolver that cannot find its evidence must be able to say so and
    // refuse. An empty buffer would look like evidence that says nothing.
    assert.equal(await rawArchive.get("no://such/ref"), null);
  });

  // ------------------------------------------------------------- key/value
  scoped("durable state round-trips values, not strings", async ({ keyValue }) => {
    await keyValue.set("gate:nonce", 42);
    await keyValue.set("gate:audit", [{ action: "closeRoom", seq: 7 }]);
    await keyValue.set("flag", false);
    await keyValue.set("empty", "");

    assert.equal(await keyValue.get("gate:nonce", null), 42, "a number comes back a number");
    assert.deepEqual(await keyValue.get("gate:audit", null), [{ action: "closeRoom", seq: 7 }]);
    assert.equal(await keyValue.get("flag", null), false, "false is a value, not a missing key");
    assert.equal(await keyValue.get("empty", null), "", "so is the empty string");
  });

  scoped("a missing key returns the caller's fallback", async ({ keyValue }) => {
    // The gate's nonce counter depends on this: `get("nextNonce", 1)` on a cold
    // start must be 1, and an adapter returning undefined would restart signing
    // at NaN.
    assert.equal(await keyValue.get("never-written", null), null);
    assert.equal(await keyValue.get("never-written", 1), 1);
    assert.deepEqual(await keyValue.get("never-written", []), []);
  });

  scoped("setting a key twice replaces it", async ({ keyValue }) => {
    await keyValue.set("cursor", 10);
    await keyValue.set("cursor", 20);
    assert.equal(await keyValue.get("cursor", null), 20);
  });

  // ---------------------------------------------------------------- leases
  scoped("a lease is exclusive until it expires", async ({ leases }) => {
    if (!leases) return;
    const first = await leases.tryAcquire("room-1", "replica-a", 1000, 0);
    assert.equal(first.term, 1);

    const blocked = await leases.tryAcquire("room-1", "replica-b", 1000, 100);
    assert.equal(blocked, null, "a live, differently-held lease refuses a second holder");
  });

  scoped("the holder renews its own lease without waiting for expiry", async ({ leases }) => {
    if (!leases) return;
    await leases.tryAcquire("room-1", "replica-a", 1000, 0);
    const renewed = await leases.tryAcquire("room-1", "replica-a", 1000, 500);
    assert.equal(renewed.term, 1, "renewal is not a handoff");
    assert.equal(renewed.expiresAt, 1500);
  });

  scoped("a new holder takes over once the lease expires, and the term climbs", async ({ leases }) => {
    if (!leases) return;
    await leases.tryAcquire("room-1", "replica-a", 1000, 0);
    const takeover = await leases.tryAcquire("room-1", "replica-b", 1000, 1000);
    assert.ok(takeover, "an expired lease is free for anyone to take");
    assert.equal(takeover.holder, "replica-b");
    assert.equal(takeover.term, 2, "the term counts handoffs, so a caller can tell one happened");
  });

  scoped("leases are scoped per room", async ({ leases }) => {
    if (!leases) return;
    await leases.tryAcquire("room-a", "replica-a", 1000, 0);
    const other = await leases.tryAcquire("room-b", "replica-b", 1000, 0);
    assert.ok(other, "one room's lease must not block another's");
  });

  // -------------------------------------------------------- resolution log
  scoped("an attestation and a challenge verdict are separate facts", async ({ resolutionLog }) => {
    // The bug that shipped: both were one upserted row, so recording a verdict
    // erased the record of having attested and the next tick attested the same
    // market a second time. Any adapter must keep them apart.
    const market = "0xmarket";
    await resolutionLog.record(market, { status: "attested", outcome: 1, evidenceHash: "0xevidence" });
    assert.equal(await resolutionLog.attested(market), true);

    await resolutionLog.recordVerdict(market, { accepted: false, outcome: 1, reason: "provisional stands" });

    assert.equal(await resolutionLog.attested(market), true, "a verdict must not erase the attestation");
    const verdict = await resolutionLog.verdict(market);
    assert.equal(verdict.accepted, false);
  });

  scoped("a resolver votes on a challenge once", async ({ resolutionLog }) => {
    await resolutionLog.recordVerdict("0xmarket", { accepted: true, outcome: 2, reason: "first" });
    await resolutionLog.recordVerdict("0xmarket", { accepted: false, outcome: 1, reason: "second" });
    const verdict = await resolutionLog.verdict("0xmarket");
    assert.equal(verdict.accepted, true, "the first vote stands; quorum is two resolvers, not one changing its mind");
  });

  scoped("a market with no record is null, not a default", async ({ resolutionLog }) => {
    assert.equal(await resolutionLog.get("0xunknown"), null);
    assert.equal(await resolutionLog.verdict("0xunknown"), null);
    assert.equal(await resolutionLog.attested("0xunknown"), false);
  });

  // ----------------------------------------------------- publication queue
  scoped("a publication request moves through its state machine", async ({ queue }) => {
    const { id } = await queue.submit({ slotIndex: 0, templateId: "tpl-participant-v1", params: { target: "1000" } });
    assert.equal((await queue.get(id)).status, "queued");

    await queue.markAwaitingPermit(id, { request: { slotIndex: 0 }, restricted: [], conditionDocument: { v: 1 } });
    assert.equal((await queue.get(id)).status, "awaiting_permit");

    await queue.markPermitted(id, { permit: { nonce: 1n }, signature: "0xsig", request: { slotIndex: 0 } });
    assert.equal((await queue.get(id)).status, "permitted");

    await queue.markPublished(id, { market: "0xmarket" });
    const published = await queue.get(id);
    assert.equal(published.status, "published");
    assert.equal(published.market, "0xmarket");
  });

  scoped("BigInt survives the round trip, because a permit is mostly BigInts", async ({ queue }) => {
    const { id } = await queue.submit({ slotIndex: 0, templateId: "tpl", params: {} });
    await queue.markAwaitingPermit(id, { request: {}, restricted: [], conditionDocument: {} });
    await queue.markPermitted(id, {
      permit: { nonce: 7n, undecidedThroughSequence: 12345678901234567890n },
      signature: "0xsig",
      request: {},
    });
    const row = await queue.get(id);
    assert.equal(typeof row.permit.nonce, "bigint", "a nonce returned as a Number would sign a different permit");
    assert.equal(row.permit.undecidedThroughSequence, 12345678901234567890n);
  });

  scoped("byStatus and open report what is actually outstanding", async ({ queue }) => {
    const a = await queue.submit({ slotIndex: 0, templateId: "tpl", params: {} });
    const b = await queue.submit({ slotIndex: 1, templateId: "tpl", params: {} });
    await queue.markRejected(b.id, "not in the catalogue");

    assert.deepEqual((await queue.byStatus("queued")).map((row) => row.id), [a.id]);
    assert.deepEqual((await queue.byStatus("rejected")).map((row) => row.id), [b.id]);
    assert.deepEqual(
      (await queue.open()).map((row) => row.id),
      [a.id],
      "a rejected request is closed; leaving it open would retry it forever"
    );
  });

  scoped("a published market traces back to the condition it was published under", async ({ queue }) => {
    // The resolver reads this to learn what question a market actually asked,
    // and refuses a document that does not hash to the chain's binding.
    const { id } = await queue.submit({ slotIndex: 0, templateId: "tpl", params: {} });
    const document = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "1000" } };
    await queue.markAwaitingPermit(id, { request: {}, restricted: [], conditionDocument: document });
    await queue.markPermitted(id, { permit: { nonce: 1n }, signature: "0x", request: {} });
    await queue.markPublished(id, { market: "0xMARKET" });

    assert.deepEqual((await queue.conditionForMarket("0xMARKET")).conditionDocument, document);
    assert.deepEqual(
      (await queue.conditionForMarket("0xmarket")).conditionDocument,
      document,
      "matched case-insensitively; the chain returns checksummed addresses and the publisher stored what it had"
    );
    assert.equal(await queue.conditionForMarket("0xNOTPUBLISHED"), null);
  });

  scoped("requests are visible to a second store on the same storage", async ({ queue, reopenQueue }) => {
    // The entire reason this queue exists: the gate and the publisher are
    // different processes. A request visible only to the writer is not a channel.
    if (!reopenQueue) return;
    const { id } = await queue.submit({ slotIndex: 0, templateId: "tpl", params: {} });
    const other = await reopenQueue();
    assert.equal((await other.get(id)).status, "queued", "another process on the same storage sees it");
  });

  // ------------------------------------------------------------------ chat
  scoped("chat is scoped per room and its ids stay globally monotonic", async ({ chat }) => {
    const a = chat.forRoom("room-a");
    const b = chat.forRoom("room-b");
    const first = await a.append({ author: "0xA", text: "hello", at: "t1" });
    const second = await b.append({ author: "0xB", text: "hi", at: "t2" });

    assert.ok(second.id > first.id, "ids climb across rooms so a signed moderation cannot be replayed");
    assert.deepEqual((await a.history()).map((m) => m.text), ["hello"], "one room does not see another's messages");
    assert.equal(await a.find(second.id), null, "nor find them by id");
  });

  scoped("a deleted message leaves the feed", async ({ chat }) => {
    const room = chat.forRoom("room-a");
    const message = await room.append({ author: "0xA", text: "gone", at: "t1" });
    await room.delete(message.id);
    assert.deepEqual((await room.history()).map((m) => m.id), []);
  });

  scoped("a timeout applies to one room only", async ({ chat }) => {
    await chat.forRoom("room-a").setTimeout("0xA", 9_999_999_999_999);
    assert.ok((await chat.forRoom("room-a").timeoutFor("0xA")) > 0, "muted here");
    assert.ok(!(await chat.forRoom("room-b").timeoutFor("0xA")), "but not everywhere");
  });

  scoped("the moderation audit is durable and per room", async ({ chat }) => {
    await chat.forRoom("room-a").audit({ moderator: "0xMOD", action: "delete", messageId: 1, at: "t1" });
    const entries = await chat.forRoom("room-a").auditLog();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].moderator, "0xMOD");
    assert.deepEqual(await chat.forRoom("room-b").auditLog(), [], "another room's moderation is not this room's record");
  });

  scoped("erasing an account tombstones their messages but leaves the row, and lifts their timeout", async ({ chat }) => {
    const room = chat.forRoom("room-a");
    const mine = await room.append({ author: "0xERASE", text: "hello", at: "t1" });
    const theirs = await room.append({ author: "0xOTHER", text: "hi", at: "t2" });
    await room.setTimeout("0xERASE", 9_999_999_999_999);

    const result = await room.eraseAccount("0xERASE");
    assert.equal(result.messagesErased, 1);
    assert.equal(result.timeoutsCleared, 1);

    const history = await room.history();
    const erased = history.find((m) => m.id === mine.id);
    assert.ok(erased, "the row stays; only its content is tombstoned");
    assert.notEqual(erased.author, "0xERASE");
    assert.notEqual(erased.text, "hello");
    assert.equal(history.find((m) => m.id === theirs.id).text, "hi", "another author's message is untouched");
    assert.equal(await room.timeoutFor("0xERASE"), 0, "the mute is lifted along with the account's data");
  });

  scoped("erasing an account reaches every room, not just the one this view is scoped to", async ({ chat }) => {
    await chat.forRoom("room-a").append({ author: "0xEVERYWHERE", text: "a", at: "t1" });
    await chat.forRoom("room-b").append({ author: "0xEVERYWHERE", text: "b", at: "t2" });

    // Erasure is a fact about the account, not about the room this store
    // instance happens to be attached to — a person's words must not survive
    // in a room the caller did not think to scope to.
    await chat.forRoom("room-a").eraseAccount("0xEVERYWHERE");

    const stillInB = (await chat.forRoom("room-b").history()).find((m) => m.text === "b");
    assert.equal(stillInB, undefined);
  });

  // ------------------------------------------------------------- referrals
  scoped("a referral binding is readable by account and by referrer", async ({ referrals }) => {
    if (!referrals?.bind) return;
    await referrals.bind({ account: "0xREFERRED", referrer: "0xREFERRER", code: "CODE1", atBlock: 100, at: "t1" });
    const binding = await referrals.bindingFor("0xREFERRED");
    assert.equal(binding.referrer.toLowerCase(), "0xreferrer");
    assert.equal((await referrals.bindingsBy("0xREFERRER")).length, 1);
  });

  scoped("an account binds once, and a rebind is refused rather than applied", async ({ referrals }) => {
    if (!referrals?.bind) return;
    await referrals.bind({ account: "0xR", referrer: "0xA", code: "A", atBlock: 1, at: "t1" });
    // Refused at the store. A silent overwrite would let a second code claim an
    // account someone else had already referred, which is the attack the signed
    // binding exists to prevent.
    await expectFailure(() => referrals.bind({ account: "0xR", referrer: "0xB", code: "B", atBlock: 2, at: "t2" }));
    const binding = await referrals.bindingFor("0xR");
    assert.equal(binding.referrer.toLowerCase(), "0xa", "the first binding stands");
  });

  scoped("erasing an account deletes their own binding and redacts their referrer role in others'", async ({ referrals }) => {
    if (!referrals?.bind) return;
    await referrals.bind({ account: "0xLEAF", referrer: "0xMIDDLE", code: "LEAF1", atBlock: 1, at: "t1" });
    await referrals.bind({ account: "0xMIDDLE", referrer: "0xROOT", code: "MID1", atBlock: 1, at: "t1" });

    const result = await referrals.eraseAccount("0xMIDDLE");
    assert.equal(result.ownBindingDeleted, true, "0xMIDDLE's own binding, as a referred account, is entirely theirs");
    assert.equal(
      result.referredBindingsRedacted,
      1,
      "the row recording that 0xMIDDLE referred 0xLEAF is someone else's binding — it stays, only the referrer is redacted"
    );

    assert.equal(await referrals.bindingFor("0xMIDDLE"), null, "their own record is gone");
    const leafBinding = await referrals.bindingFor("0xLEAF");
    assert.ok(leafBinding, "0xLEAF's own binding is not the erased account's data to lose");
    assert.notEqual(leafBinding.referrer.toLowerCase(), "0xmiddle", "but it no longer names the erased account");
  });

  // ----------------------------------------------------------- acceptances
  scoped("terms acceptance records a version and a proof flag separately", async ({ acceptances }) => {
    await acceptances.set("0xACC", "v1");
    assert.equal(await acceptances.get("0xACC"), "v1");
    assert.equal(await acceptances.proven("0xACC"), false, "accepted is not the same as proven by signature");
    await acceptances.setProven("0xACC", true);
    assert.equal(await acceptances.proven("0xACC"), true);
    // Pinned as undefined rather than normalised to null: callers distinguish
    // "never accepted" from "accepted nothing", and an adapter returning null
    // here would be a different answer to that question.
    assert.equal(await acceptances.get("0xNONE"), undefined, "an account that never accepted is undefined");
  });

  scoped("erasing an account removes their terms acceptance entirely", async ({ acceptances }) => {
    await acceptances.set("0xGONE", "v1");
    await acceptances.setProven("0xGONE", true);

    const result = await acceptances.eraseAccount("0xGONE");
    assert.equal(result.deleted, true);
    assert.equal(await acceptances.get("0xGONE"), undefined);
    assert.equal(await acceptances.proven("0xGONE"), false, "no record left to be proven");
  });

  // --------------------------------------------------------- oracle proofs
  scoped("an oracle proof is findable by id, hash and market", async ({ oracle }) => {
    if (!oracle?.put) return;
    // The flat shape the store persists. The service above it normalises the
    // market address to lowercase on both write and read, so the store's exact
    // match is correct.
    const record = {
      id: "proof-1",
      market: "0xmarket",
      outcome: 1,
      stream_url: "https://example.com/live",
      occurred_at: "2026-01-01T00:00:00.000Z",
      clip_start_ms: 0,
      clip_end_ms: 1000,
      rule: "r",
      rationale: "why",
      clip_sha256: "0xclip",
      evidence_hash: "0xhash",
      canonical_json: "{}",
      video_path: "blobs/proof-1.mp4",
      byte_length: 4,
      mime_type: "video/mp4",
      created_at: "2026-01-01T00:00:00.000Z",
    };
    await oracle.put(record);
    assert.equal((await oracle.byId("proof-1")).evidence_hash, "0xhash");
    assert.equal((await oracle.byEvidenceHash("0xhash")).id, "proof-1");
    assert.equal((await oracle.latestForMarket("0xmarket")).id, "proof-1");
    assert.equal((await oracle.latestForMarket("0xunknown")) ?? null, null, "a market with no evidence is null");
  });
}
