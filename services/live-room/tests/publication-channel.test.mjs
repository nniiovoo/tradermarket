// The durable publication channel: Gate → Publisher → chain.
//
// Publication needs two authorities and the design only means something if
// they are two *processes*. Until now the publisher built a GateAuthority in
// its own address space and signed the permit with its own key, which is the
// same key holding both roles wearing a hat. These pin the real shape:
//
//   - a request is durable the moment it is accepted, so a restart between
//     "accepted" and "published" loses nothing;
//   - the publisher validates against the frozen catalog and then STOPS,
//     because it cannot decide whether the question is still open;
//   - the gate signs with the gate key, in the gate process, and hands back a
//     permit;
//   - the publisher submits that permit with the publisher key;
//   - a permit that went stale while the publisher was down is re-requested,
//     never submitted;
//   - a retry after a lost receipt reconciles against the chain instead of
//     publishing the same question twice.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

import { openDatabase, SqliteEventStore, SqliteKeyValue } from "../src/ports/sqlite-stores.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";
import { QueuedPublisher } from "../src/publisher/queue.mjs";
import { PermitServer } from "../src/gate/permit-server.mjs";
import { GateAuthority } from "../src/gate/authority.mjs";
import { firstTemplateCatalog } from "../src/publisher/publisher.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";

const GATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PUBLISHER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const ROOM = "0x2222222222222222222222222222222222222222";
const CHAIN_ID = 31337;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-pub-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A live source: without one the gate refuses every permit as stale. */
function seedLog(store, nowMs) {
  store.append({
    seq: 1,
    kind: "heartbeat",
    observed_at: new Date(nowMs).toISOString(),
    hash: "0xfeed",
  });
}

function candidate(overrides = {}) {
  return {
    slotIndex: 0,
    templateId: "tpl-participant-v1",
    params: { target: "10000" },
    question: "Who reaches $10,000 realized PnL first?",
    announceDelay: 30,
    ...overrides,
  };
}

/**
 * The two processes, sharing only a database file — which is exactly what they
 * share in production, and nothing else.
 */
function twoProcesses(dir, { nowMs = 1_700_000_000_000 } = {}) {
  const gateDb = openDatabase(join(dir, "room.db"));
  const publisherDb = openDatabase(join(dir, "room.db"));

  const gateLog = new SqliteEventStore(gateDb);
  seedLog(gateLog, nowMs);

  const chain = new FakeRoomChain();
  const gate = new GateAuthority({
    roomAddress: ROOM,
    chainId: CHAIN_ID,
    chain,
    store: gateLog,
    signer: privateKeyToAccount(GATE_KEY),
    conditions: new Map(),
    state: new SqliteKeyValue(gateDb),
    config: {
      epochDurationS: 60,
      sourceFinalityDelayS: 15,
      freshnessThresholdMs: 20_000,
      maxPermitLifetimeS: 300,
      maxPendingTimeS: 900,
      unevaluableGraceMs: 60_000,
      chainNow: async () => Math.floor(nowMs / 1000),
      headlineMarket: null,
    },
  });

  const permitServer = new PermitServer({
    gate,
    queue: new SqlitePublicationQueue(gateDb, "room-1"),
  });

  const publisher = new QueuedPublisher({
    chain,
    queue: new SqlitePublicationQueue(publisherDb, "room-1"),
    catalog: firstTemplateCatalog(),
    config: { minAnnounceDelay: 30 },
  });

  return {
    chain,
    gate,
    permitServer,
    publisher,
    close: () => {
      gateDb.close();
      publisherDb.close();
    },
  };
}

test("an accepted question is durable before anything else happens to it", async () => {
  const { dir, clean } = scratch();
  try {
    const first = openDatabase(join(dir, "room.db"));
    const { id } = await new SqlitePublicationQueue(first, "room-1").submit(candidate());
    first.close();

    // The publisher dies here, between acceptance and publication.
    const second = openDatabase(join(dir, "room.db"));
    const queue = new SqlitePublicationQueue(second, "room-1");
    const record = await queue.get(id);
    assert.equal(record.status, "queued", "a restart must not lose an accepted question");
    assert.equal(record.candidate.templateId, "tpl-participant-v1");
    second.close();
  } finally {
    clean();
  }
});

test("a question from outside the frozen catalog never reaches the gate", async () => {
  const { dir, clean } = scratch();
  const world = twoProcesses(dir);
  try {
    const { id } = await world.publisher.queue.submit(candidate({ templateId: "tpl-anything-goes" }));
    await world.publisher.tick({ nowMs: 1_700_000_000_000 });

    const record = await world.publisher.queue.get(id);
    assert.equal(record.status, "rejected");
    assert.match(record.reason, /not approved/);
    assert.equal(
      (await world.permitServer.queue.awaitingPermit()).length,
      0,
      "an unapproved template must never occupy the gate's attention"
    );
  } finally {
    world.close();
    clean();
  }
});

test("the gate signs with the gate key and the publisher submits with its own", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const { id } = await world.publisher.queue.submit(candidate());

    // 1. Publisher process: validate against the catalog, then stop.
    await world.publisher.tick({ nowMs });
    assert.equal((await world.publisher.queue.get(id)).status, "awaiting_permit");
    assert.equal(world.chain.calls.length, 0, "nothing is on chain until the gate has signed");

    // 2. Gate process: sign, with its own key, in its own process.
    await world.permitServer.tick({ nowMs });
    const permitted = await world.publisher.queue.get(id);
    assert.equal(permitted.status, "permitted", permitted.reason ?? "");

    const signer = await recoverTypedDataAddress({
      domain: { name: "TraderMarket LiveRoom", version: "1", chainId: CHAIN_ID, verifyingContract: ROOM },
      types: {
        PublicationPermit: [
          { name: "room", type: "address" },
          { name: "slotIndex", type: "uint32" },
          { name: "requestHash", type: "bytes32" },
          { name: "conditionHash", type: "bytes32" },
          { name: "undecidedThroughSequence", type: "uint256" },
          { name: "announceDelay", type: "uint64" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "PublicationPermit",
      message: { room: ROOM, ...permitted.permit },
      signature: permitted.signature,
    });
    assert.equal(
      signer.toLowerCase(),
      privateKeyToAccount(GATE_KEY).address.toLowerCase(),
      "the permit must carry the GATE's signature, not the publisher's"
    );
    assert.notEqual(
      signer.toLowerCase(),
      privateKeyToAccount(PUBLISHER_KEY).address.toLowerCase(),
      "a publisher that signs its own permit has defeated the separation"
    );

    // 3. Publisher process: submit it.
    await world.publisher.tick({ nowMs });
    const published = await world.publisher.queue.get(id);
    assert.equal(published.status, "published", published.reason ?? "");
    assert.match(published.market, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(world.chain.published.length, 1, "exactly one market, published once");
  } finally {
    world.close();
    clean();
  }
});

test("a permit that expired while the publisher was down is re-requested, not submitted", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const { id } = await world.publisher.queue.submit(candidate());
    await world.publisher.tick({ nowMs });
    await world.permitServer.tick({ nowMs });
    assert.equal((await world.publisher.queue.get(id)).status, "permitted");

    // The publisher was down for an hour. maxPermitLifetimeS is 300.
    const later = nowMs + 3_600_000;
    await world.publisher.tick({ nowMs: later });

    const record = await world.publisher.queue.get(id);
    assert.equal(
      record.status,
      "awaiting_permit",
      "a stale permit is worth nothing on chain; the room must be asked again"
    );
    assert.equal(record.permit, null, "and the dead permit is not kept around to be submitted later");
    assert.equal(world.chain.published.length, 0, "the expired permit was never sent");
  } finally {
    world.close();
    clean();
  }
});

test("a publication whose permit the room already consumed is reconciled, not published twice", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const { id } = await world.publisher.queue.submit(candidate());
    await world.publisher.tick({ nowMs });
    await world.permitServer.tick({ nowMs });

    // The transaction lands; the receipt never comes back. The publisher's
    // record still says "permitted" and it is about to try again.
    const permitted = await world.publisher.queue.get(id);
    const market = await world.chain.publishSlot(
      { ...permitted.request, conditionHash: permitted.permit.conditionHash },
      permitted.permit,
      permitted.signature,
      permitted.restricted
    );

    await world.publisher.tick({ nowMs });

    const record = await world.publisher.queue.get(id);
    assert.equal(record.status, "published");
    assert.equal(record.market, market, "the record names the market that actually landed");
    assert.equal(world.chain.published.length, 1, "the same question must not be published twice");
  } finally {
    world.close();
    clean();
  }
});

test("a refused permit is recorded with its reason and never retried blindly", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const { id } = await world.publisher.queue.submit(candidate());
    await world.publisher.tick({ nowMs });

    // The source has gone quiet: the gate must not authorise a market on it.
    await world.permitServer.tick({ nowMs: nowMs + 60_000 });

    const record = await world.publisher.queue.get(id);
    assert.equal(record.status, "refused");
    assert.match(record.reason, /stale/i);

    await world.publisher.tick({ nowMs: nowMs + 60_000 });
    assert.equal(world.chain.published.length, 0, "a refusal is an answer, not a transient error");
    assert.equal((await world.publisher.queue.get(id)).status, "refused");
  } finally {
    world.close();
    clean();
  }
});

test("the condition document the gate froze is kept with the record, for the resolver", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const { id } = await world.publisher.queue.submit(candidate());
    await world.publisher.tick({ nowMs });
    await world.permitServer.tick({ nowMs });
    await world.publisher.tick({ nowMs });

    const record = await world.publisher.queue.get(id);
    assert.equal(record.status, "published");
    assert.equal(
      conditionHash(record.conditionDocument),
      record.permit.conditionHash,
      "the stored document must hash to what the chain was told, or the resolver cannot use it"
    );
  } finally {
    world.close();
    clean();
  }
});

test("the slot index comes from the chain, and only one publication is in flight at a time", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const first = await world.publisher.queue.submit(candidate({ slotIndex: null, question: "first" }));
    const second = await world.publisher.queue.submit(candidate({ slotIndex: null, question: "second" }));

    await world.publisher.tick({ nowMs });
    assert.equal((await world.publisher.queue.get(first.id)).status, "awaiting_permit");
    assert.equal(
      (await world.publisher.queue.get(second.id)).status,
      "queued",
      "two permits for the same slot index cannot both land; the second waits its turn"
    );

    await world.permitServer.tick({ nowMs });
    assert.equal(
      Number((await world.publisher.queue.get(first.id)).permit.slotIndex),
      0,
      "the index is the room's own slot count, not something an operator typed"
    );

    await world.publisher.tick({ nowMs });
    assert.equal((await world.publisher.queue.get(first.id)).status, "published");

    // Now the second one moves, and gets the next index.
    await world.publisher.tick({ nowMs });
    await world.permitServer.tick({ nowMs });
    assert.equal(Number((await world.publisher.queue.get(second.id)).permit.slotIndex), 1);
    await world.publisher.tick({ nowMs });
    assert.equal((await world.publisher.queue.get(second.id)).status, "published");
    assert.equal(world.chain.published.length, 2);
  } finally {
    world.close();
    clean();
  }
});

test("a permit for a slot index the room has moved past is re-requested, not submitted", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const { id } = await world.publisher.queue.submit(candidate({ slotIndex: null }));
    await world.publisher.tick({ nowMs });
    await world.permitServer.tick({ nowMs });

    // Something else took slot 0 — a manual publication, or a second publisher
    // that should not exist. Either way this permit is now for the wrong slot.
    world.chain.addSlot("0x00000000000000000000000000000000000000ff", 0, "0xdead");

    await world.publisher.tick({ nowMs });

    const record = await world.publisher.queue.get(id);
    assert.equal(record.status, "awaiting_permit", "the permit is dead; ask again rather than pay for a revert");
    assert.equal(world.chain.published.length, 0);
  } finally {
    world.close();
    clean();
  }
});

test("a network failure leaves the publication to be retried; a revert does not", async () => {
  const { dir, clean } = scratch();
  const nowMs = 1_700_000_000_000;
  const world = twoProcesses(dir, { nowMs });
  try {
    const { id } = await world.publisher.queue.submit(candidate({ slotIndex: null }));
    await world.publisher.tick({ nowMs });
    await world.permitServer.tick({ nowMs });

    // The RPC endpoint is unreachable. That says nothing about the question,
    // and burning it would mean an operator has to notice and re-queue every
    // market that happened to be in flight during a blip.
    const real = world.chain.publishSlot.bind(world.chain);
    world.chain.publishSlot = async () => {
      const error = new Error("fetch failed");
      error.name = "HttpRequestError";
      throw error;
    };
    await world.publisher.tick({ nowMs });
    assert.equal(
      (await world.publisher.queue.get(id)).status,
      "permitted",
      "an unreachable endpoint is not a verdict on the question"
    );

    // The room refusing it is a verdict, and a permanent one.
    world.chain.publishSlot = async () => {
      const error = new Error("execution reverted: TemplateNotApproved");
      error.shortMessage = "execution reverted: TemplateNotApproved";
      error.name = "ContractFunctionExecutionError";
      throw error;
    };
    await world.publisher.tick({ nowMs });
    const failed = await world.publisher.queue.get(id);
    assert.equal(failed.status, "failed");
    assert.match(failed.reason, /TemplateNotApproved/);

    world.chain.publishSlot = real;
  } finally {
    world.close();
    clean();
  }
});
