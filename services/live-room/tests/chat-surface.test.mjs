// P1 chat and moderation over HTTP.
//
// Two truthfulness rules are under test. First, a deployment that has not
// enabled chat must not serve a chat surface: the capability report and the API
// have to agree, or the website is told one thing and the reader another.
// Second, moderation has to be reachable — a chat with no way to remove a
// message is not a moderated chat, whatever the service class can do offline.

import test from "node:test";
import assert from "node:assert/strict";

import { RoomApiServer } from "../src/api/server.mjs";
import { ChatService, RealtimeEdge, PlaybackService } from "../src/edge/edge.mjs";
import { LiveRoomCoordinator } from "../src/coordinator/coordinator.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { MemoryEventStore } from "../src/ports/stores.mjs";
import { Capabilities } from "../src/config/capabilities.mjs";

const MOD = "0xMOD";

async function harness({ chatEnabled }) {
  const store = new ProjectionStore();
  const eventLog = new MemoryEventStore();
  const edgeRef = {};
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog,
    publishTo: (frame) => edgeRef.edge?.broadcast(frame),
    config: { freshnessThresholdMs: 20_000, retention: 50, heartbeatMs: 10_000 },
  });
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 32 } });
  edgeRef.edge = edge;
  const chat = new ChatService({
    verifySignature: async (_a, _t, signature) => signature === "0xGOOD",
    // Mirrors the composition root, which supplies the room and lowercases the
    // configured moderator set.
    config: { roomId: "room-1", rateLimitPerMinute: 5, moderators: new Set([MOD.toLowerCase()]) },
  });
  const playback = new PlaybackService({ config: { degradedAfterMs: 5000, disclosedDelayS: 0 } });
  const capabilities = new Capabilities({
    room: { apiUrl: "http://127.0.0.1:1" },
    chat: { enabled: chatEnabled },
  });
  const server = new RoomApiServer({ coordinator, edge, chat, playback, store, eventLog, capabilities });
  const address = await server.listen(0);
  coordinator.tick();
  return { server, chat, base: `http://127.0.0.1:${address.port}` };
}

/** A post body carrying the bound claim the service requires. */
function chatBody(chat, { roomId = "room-1", address, text, signature = "0xGOOD", issuedAt = Date.now() }) {
  return { address, text, claim: chat.claimFor({ roomId, address, text, issuedAt }), signature };
}

/** A moderation body carrying its bound claim. */
function moderationBody(chat, { roomId = "room-1", moderator, messageId, action, untilMs = 0, signature = "0xGOOD" }) {
  return {
    moderator,
    messageId,
    action,
    untilMs,
    claim: chat.moderationClaimFor({ roomId, moderator, messageId, action, untilMs, issuedAt: Date.now() }),
    signature,
  };
}

async function post(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("a deployment without chat serves no chat surface and says why", async () => {
  const { server, chat, base } = await harness({ chatEnabled: false });
  try {
    const read = await fetch(`${base}/v1/rooms/room-1/chat`);
    assert.equal(read.status, 503, "reading chat must not succeed where chat is not configured");
    const readBody = await read.json();
    assert.match(readBody.reason, /not enabled/i);
    assert.deepEqual(readBody.messages, [], "an unconfigured deployment must not invent messages");

    const write = await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "hello" }));
    assert.equal(write.status, 503);
    assert.equal(write.body.ok, false);
  } finally {
    await server.close();
  }
});

test("an enabled deployment serves chat and the pinned non-authoritative rule", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  try {
    const write = await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "alice looks locked in" }));
    assert.equal(write.status, 200);

    const read = await fetch(`${base}/v1/rooms/room-1/chat`);
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.equal(body.messages.length, 1);
    assert.match(body.pinned.text, /cannot change a result/i);
    assert.equal(body.messages[0].presentation_only, true);
  } finally {
    await server.close();
  }
});

test("moderation is reachable over HTTP and only by a moderator", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  try {
    await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "spam" }));

    const notModerator = await post(
      base,
      "/v1/rooms/room-1/chat/moderate",
      moderationBody(chat, { moderator: "0xNOTAMOD", messageId: 1, action: "delete" })
    );
    assert.equal(notModerator.status, 403, "a stranger must not be able to delete a message");

    const still = await (await fetch(`${base}/v1/rooms/room-1/chat`)).json();
    assert.equal(still.messages.length, 1, "a rejected moderation must not remove the message");

    const removed = await post(
      base,
      "/v1/rooms/room-1/chat/moderate",
      moderationBody(chat, { moderator: MOD, messageId: 1, action: "delete" })
    );
    assert.equal(removed.status, 200);

    const after = await (await fetch(`${base}/v1/rooms/room-1/chat`)).json();
    assert.equal(after.messages.length, 0, "a deleted message must leave the history");
  } finally {
    await server.close();
  }
});

test("a timed-out author is refused by the API, not silently accepted", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  try {
    await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "one" }));
    const until = Date.now() + 60_000;
    const timeout = await post(
      base,
      "/v1/rooms/room-1/chat/moderate",
      moderationBody(chat, { moderator: MOD, messageId: 1, action: "timeout", untilMs: until })
    );
    assert.equal(timeout.status, 200);
    assert.equal(await chat.store.timeoutFor("0xA"), until, "timeouts are keyed on the lowercased address");

    const blocked = await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "two" }));
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.reason, /timed out/i);
  } finally {
    await server.close();
  }
});

test("moderation requires proof, not just a claimed address", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  try {
    await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "hello" }));

    // The moderator address is public. Naming it must not be enough to act as
    // them, or anyone who has ever seen a moderation can delete any message.
    const impersonated = await post(
      base,
      "/v1/rooms/room-1/chat/moderate",
      moderationBody(chat, { moderator: MOD, messageId: 1, action: "delete", signature: "0xFORGED" })
    );
    assert.equal(impersonated.status, 403, "an unproven moderator claim must be refused");

    const intact = await (await fetch(`${base}/v1/rooms/room-1/chat`)).json();
    assert.equal(intact.messages.length, 1, "the message must survive an unproven moderation");

    const proven = await post(
      base,
      "/v1/rooms/room-1/chat/moderate",
      moderationBody(chat, { moderator: MOD, messageId: 1, action: "delete" })
    );
    assert.equal(proven.status, 200);
  } finally {
    await server.close();
  }
});

test("a moderator is recognised whatever the case of their address", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  try {
    await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "hello" }));

    // Wallets hand back checksummed addresses; configuration is often typed in
    // lower case. Ethereum address case is a checksum, never an identity.
    const mixedCase = await post(
      base,
      "/v1/rooms/room-1/chat/moderate",
      moderationBody(chat, { moderator: MOD.toUpperCase(), messageId: 1, action: "delete" })
    );
    assert.equal(mixedCase.status, 200, "case must not decide whether someone is a moderator");
  } finally {
    await server.close();
  }
});

test("re-casing an address does not reset a rate limit or escape a timeout", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.config.rateLimitPerMinute = 3;
  chat.config.slowModeMs = 0;
  try {
    // Ethereum address case is a checksum. viem recovers the signer and
    // compares case-insensitively, so every case variant of one address
    // verifies — and there are 2^40 variants of a single address.
    const variants = ["0xabcdef0001", "0xAbCdEf0001", "0xABCDEF0001"];
    let accepted = 0;
    for (const [v, variant] of variants.entries()) {
      for (let i = 0; i < 3; i += 1) {
        const result = await post(
          base,
          "/v1/rooms/room-1/chat",
          chatBody(chat, { address: variant, text: `message ${v}-${i}` })
        );
        if (result.status === 200) accepted += 1;
      }
    }
    assert.equal(accepted, 3, "one address gets one rate limit, whatever case it is written in");

    const history = await (await fetch(`${base}/v1/rooms/room-1/chat`)).json();
    const timeout = await post(
      base,
      "/v1/rooms/room-1/chat/moderate",
      moderationBody(chat, {
        moderator: MOD,
        messageId: history.messages[0].id,
        action: "timeout",
        untilMs: Date.now() + 60_000,
      })
    );
    assert.equal(timeout.status, 200);

    const evasion = await post(
      base,
      "/v1/rooms/room-1/chat",
      chatBody(chat, { address: "0xABCDEF0001", text: "again" })
    );
    assert.equal(evasion.status, 400, "a timed-out author must not post by flipping a hex letter's case");
    assert.match(evasion.body.reason, /timed out/i);
  } finally {
    await server.close();
  }
});

test("a chat signature is bound to this room and cannot be replayed", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  // A verifier that only accepts a signature matching the exact claim string,
  // as a real signature check does.
  chat.verify = async (_address, message, signature) => signature === `sig:${message}`;
  try {
    const claim = chat.claimFor({ roomId: "room-1", address: "0xA", text: "hello", issuedAt: Date.now() });
    assert.match(claim, /room-1/, "the claim names the room it is for");
    assert.match(claim, /hello/);

    const first = await post(base, "/v1/rooms/room-1/chat", {
      address: "0xA",
      text: "hello",
      claim,
      signature: `sig:${claim}`,
    });
    assert.equal(first.status, 200, "a properly bound signature posts");

    // The identical payload again is a replay, not a second message.
    const replay = await post(base, "/v1/rooms/room-1/chat", {
      address: "0xA",
      text: "hello",
      claim,
      signature: `sig:${claim}`,
    });
    assert.equal(replay.status, 400);
    assert.match(replay.body.reason, /replay|already/i);

    const history = await (await fetch(`${base}/v1/rooms/room-1/chat`)).json();
    assert.equal(history.messages.length, 1, "a replayed signature must not post twice");
  } finally {
    await server.close();
  }
});

test("a stale chat signature is refused", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.verify = async (_address, message, signature) => signature === `sig:${message}`;
  try {
    const old = chat.claimFor({ roomId: "room-1", address: "0xA", text: "old", issuedAt: 1_000 });
    const result = await post(base, "/v1/rooms/room-1/chat", {
      address: "0xA",
      text: "old",
      claim: old,
      signature: `sig:${old}`,
    });
    assert.equal(result.status, 400);
    assert.match(result.body.reason, /expired|stale|too old/i);
  } finally {
    await server.close();
  }
});

test("a moderation signature is bound and cannot be replayed after a restart", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.verify = async (_address, message, signature) => signature === `sig:${message}`;
  try {
    const postClaim = chat.claimFor({ roomId: "room-1", address: "0xA", text: "spam", issuedAt: Date.now() });
    await post(base, "/v1/rooms/room-1/chat", {
      address: "0xA",
      text: "spam",
      claim: postClaim,
      signature: `sig:${postClaim}`,
    });

    const claim = chat.moderationClaimFor({
      roomId: "room-1",
      moderator: MOD,
      messageId: 1,
      action: "delete",
      untilMs: 0,
      issuedAt: Date.now(),
    });
    assert.match(claim, /room-1/, "the claim names the room");
    assert.match(claim, /delete/);

    const first = await post(base, "/v1/rooms/room-1/chat/moderate", {
      moderator: MOD, messageId: 1, action: "delete", claim, signature: `sig:${claim}`,
    });
    assert.equal(first.status, 200);

    // Message ids restart at 1 on a fresh process, so an unbound moderation
    // signature would delete whatever message #1 happens to be next time.
    const replay = await post(base, "/v1/rooms/room-1/chat/moderate", {
      moderator: MOD, messageId: 1, action: "delete", claim, signature: `sig:${claim}`,
    });
    assert.equal(replay.status, 400);
    assert.match(replay.body.reason, /replay|already/i);
  } finally {
    await server.close();
  }
});

test("omitting the claim does not fall back to an unbound signature", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.verify = async (_address, message, signature) => signature === `sig:${message}`;
  try {
    // Accepting a bare-text signature when no claim is supplied hands the
    // bypass to anyone who wants it: omit the field, and every property the
    // claim was introduced to guarantee — room, expiry, single use — is gone.
    const result = await post(base, "/v1/rooms/room-1/chat", {
      address: "0xA",
      text: "unbound",
      signature: "sig:unbound",
    });
    assert.equal(result.status, 400);
    assert.match(result.body.reason, /claim|bound|signature/i);

    const history = await (await fetch(`${base}/v1/rooms/room-1/chat`)).json();
    assert.equal(history.messages.length, 0);
  } finally {
    await server.close();
  }
});

test("moderation without a claim is refused too", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.verify = async (_address, message, signature) => signature === `sig:${message}`;
  try {
    const claim = chat.claimFor({ roomId: "room-1", address: "0xA", text: "hi", issuedAt: Date.now() });
    await post(base, "/v1/rooms/room-1/chat", { address: "0xA", text: "hi", claim, signature: `sig:${claim}` });

    const unbound = await post(base, "/v1/rooms/room-1/chat/moderate", {
      moderator: MOD,
      messageId: 1,
      action: "delete",
      signature: "sig:delete:1:0",
    });
    assert.equal(unbound.status, 403);
  } finally {
    await server.close();
  }
});

test("used claims do not accumulate on a moderation-only deployment", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  try {
    await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: "hi" }));

    // Pruning ran only on a successful post, so a deployment where moderation
    // is the only traffic accumulated a used-claim entry per action, forever.
    for (let i = 0; i < 5; i += 1) {
      await post(
        base,
        "/v1/rooms/room-1/chat/moderate",
        moderationBody(chat, { moderator: MOD, messageId: 1, action: "timeout", untilMs: i + 1 })
      );
    }
    const before = chat.usedClaims.size;
    assert.ok(before > 0);

    // Everything ages out once it is past its lifetime.
    await chat._prune(Date.now() + 10 * 60_000);
    assert.equal(chat.usedClaims.size, 0, "expired claims must be released");
    assert.equal(await chat.store.timeoutFor("0xA"), 0, "and expired timeouts with them");
  } finally {
    await server.close();
  }
});

test("the caller does not get to say what time it is", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.config.rateLimitPerMinute = 3;
  chat.config.slowModeMs = 0;
  try {
    // Every control the claim adds — expiry, single use, rate limits, timeouts
    // — is measured against a clock. Taking that clock from the request body
    // hands all of them to the caller, and stamps chat history with whatever
    // time they choose.
    const ancient = chat.claimFor({ roomId: "room-1", address: "0xA", text: "old", issuedAt: 1_600_000_000_000 });
    const stale = await post(base, "/v1/rooms/room-1/chat", {
      address: "0xA",
      text: "old",
      claim: ancient,
      signature: "0xGOOD",
      nowMs: 1_600_000_000_000,
    });
    assert.equal(stale.status, 400, "a six-year-old claim must not post by asserting a matching clock");

    // Rate limits measured on a caller-supplied clock are not limits.
    let accepted = 0;
    for (let i = 0; i < 20; i += 1) {
      const at = Date.now() + i * 120_000;
      const result = await post(base, "/v1/rooms/room-1/chat", {
        address: "0xB",
        text: `spam ${i}`,
        claim: chat.claimFor({ roomId: "room-1", address: "0xB", text: `spam ${i}`, issuedAt: at }),
        signature: "0xGOOD",
        nowMs: at,
      });
      if (result.status === 200) accepted += 1;
    }
    assert.ok(accepted <= 3, `a caller-set clock must not lift the rate limit (accepted ${accepted})`);

    // And the stored timestamp must be the server's, not the caller's.
    const history = await (await fetch(`${base}/v1/rooms/room-1/chat`)).json();
    for (const message of history.messages) {
      assert.ok(
        Math.abs(Date.parse(message.at) - Date.now()) < 120_000,
        `a message is stamped with the server's clock, not ${message.at}`
      );
    }
  } finally {
    await server.close();
  }
});

test("a rate-limited request leaves nothing behind", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.config.rateLimitPerMinute = 2;
  chat.config.slowModeMs = 0;
  try {
    // The claim was recorded as used before the rate-limit check returned, and
    // pruning ran after it — so every rejected request added an entry that was
    // never released. The keys are caller-chosen strings bounded only by the
    // body cap, and a valid self-signed signature is free to produce.
    for (let i = 0; i < 40; i += 1) {
      await post(base, "/v1/rooms/room-1/chat", chatBody(chat, { address: "0xA", text: `spam ${i}` }));
    }
    assert.ok(
      chat.usedClaims.size <= 4,
      `a rejected request must not retain its claim (retained ${chat.usedClaims.size})`
    );
  } finally {
    await server.close();
  }
});

test("a claim with an empty room segment is not valid everywhere", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  try {
    // `room && claimRoom && claimRoom !== room` skipped the check whenever the
    // claim's room field was blank, so an unbound claim passed in every room.
    const blank = ["tradermarket-chat-v1", "", "0xa", String(Date.now()), "hello"].join("\n");
    const result = await post(base, "/v1/rooms/room-1/chat", {
      address: "0xA",
      text: "hello",
      claim: blank,
      signature: "0xGOOD",
    });
    assert.equal(result.status, 400);
    assert.match(result.body.reason, /room/i);
  } finally {
    await server.close();
  }
});

test("the service's claim string is exactly what the website builds", () => {
  const chat = new ChatService({ verifySignature: async () => true, config: { roomId: "room-1" } });
  const built = chat.claimFor({ roomId: "room-1", address: "0xAbC", text: "hello", issuedAt: 42 });

  // The website has its own copy of this string in
  // prototype/live-market-app/src/chat-claim.js, pinned by the same assertion.
  // If either side changes shape without the other, every post is rejected with
  // "claim does not match" — so both are pinned to this literal.
  assert.deepEqual(built.split("\n"), ["tradermarket-chat-v1", "room-1", "0xabc", "42", "hello"]);
});

test("a used claim stays used for as long as it stays valid", async () => {
  const { server, chat, base } = await harness({ chatEnabled: true });
  chat.verify = async () => true;
  try {
    // A claim is valid until issuedAt + lifetime, but was pruned at
    // recordedAt + lifetime. With issuedAt allowed up to the skew ahead of the
    // server clock, the validity window outlived the replay guard by that
    // margin — so the same claim and signature posted a second message.
    const T = Date.now();
    const claim = chat.claimFor({ roomId: "room-1", address: "0xA", text: "once", issuedAt: T + 55_000 });

    const first = await chat.post({ address: "0xA", text: "once", claim, signature: "0xGOOD", nowMs: T });
    assert.equal(first.ok, true);

    // Any later successful post runs the pruner.
    await chat.post({
      address: "0xB",
      text: "other",
      claim: chat.claimFor({ roomId: "room-1", address: "0xB", text: "other", issuedAt: T + 300_001 }),
      signature: "0xGOOD",
      nowMs: T + 300_001,
    });

    const replay = await chat.post({ address: "0xA", text: "once", claim, signature: "0xGOOD", nowMs: T + 300_002 });
    assert.equal(replay.ok, false, "the claim must not become replayable while it is still valid");
    assert.match(replay.reason, /replay|expired/i);
  } finally {
    await server.close();
  }
});

test("one claim posts once even when requests arrive together", async () => {
  const chat = new ChatService({
    // A verifier that yields, as a real signature check does.
    verifySignature: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
    config: { roomId: "room-1", rateLimitPerMinute: 99 },
  });

  // Single-use was a check-then-act across an await: every concurrent request
  // passed the `has` check before any of them reached the `set`, so one signed
  // claim posted as many times as it was sent.
  const claim = chat.claimFor({ roomId: "room-1", address: "0xA", text: "once", issuedAt: Date.now() });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => chat.post({ address: "0xA", text: "once", claim, signature: "0xS" }))
  );

  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one of five concurrent posts is accepted");
  assert.equal((await chat.history()).length, 1);
});

test("one moderation claim acts once even when requests arrive together", async () => {
  const chat = new ChatService({
    verifySignature: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
    config: { roomId: "room-1", rateLimitPerMinute: 99, moderators: new Set(["0xmod"]) },
  });
  const post = chat.claimFor({ roomId: "room-1", address: "0xA", text: "spam", issuedAt: Date.now() });
  await chat.post({ address: "0xA", text: "spam", claim: post, signature: "0xS" });

  const claim = chat.moderationClaimFor({
    roomId: "room-1", moderator: "0xMOD", messageId: 1, action: "timeout", untilMs: 1, issuedAt: Date.now(),
  });
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      chat.moderate({ moderator: "0xMOD", messageId: 1, action: "timeout", untilMs: 1, claim, signature: "0xS" })
    )
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("chat history and moderation survive a process restart", async () => {
  const { SqliteChatStore, openDatabase } = await import("../src/ports/sqlite-stores.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "tm-chat-"));
  const path = join(dir, "room.db");
  try {
    const makeChat = () =>
      new ChatService({
        verifySignature: async () => true,
        config: { roomId: "room-1", rateLimitPerMinute: 99, moderators: new Set(["0xmod"]) },
        store: new SqliteChatStore(openDatabase(path)),
      });

    const before = makeChat();
    const claim = before.claimFor({ roomId: "room-1", address: "0xA", text: "hello", issuedAt: Date.now() });
    const posted = await before.post({ address: "0xA", text: "hello", claim, signature: "0xS" });
    assert.equal(posted.ok, true);

    const spamClaim = before.claimFor({ roomId: "room-1", address: "0xB", text: "spam", issuedAt: Date.now() });
    const spam = await before.post({ address: "0xB", text: "spam", claim: spamClaim, signature: "0xS" });
    const modClaim = before.moderationClaimFor({
      roomId: "room-1", moderator: "0xMOD", messageId: spam.message.id,
      action: "timeout", untilMs: Date.now() + 3_600_000, issuedAt: Date.now(),
    });
    await before.moderate({
      moderator: "0xMOD", messageId: spam.message.id, action: "timeout",
      untilMs: Date.now() + 3_600_000, claim: modClaim, signature: "0xS",
    });

    // A new process against the same file.
    const after = makeChat();
    assert.equal((await after.history()).length, 2, "the conversation is still there");

    const evade = after.claimFor({ roomId: "room-1", address: "0xB", text: "again", issuedAt: Date.now() });
    const blocked = await after.post({ address: "0xB", text: "again", claim: evade, signature: "0xS" });
    assert.equal(blocked.ok, false, "a moderator's timeout is not a restart away from being lifted");
    assert.match(blocked.reason, /timed out/i);

    // And ids keep climbing, so a signed moderation cannot land on a new message.
    const next = after.claimFor({ roomId: "room-1", address: "0xA", text: "third", issuedAt: Date.now() });
    const third = await after.post({ address: "0xA", text: "third", claim: next, signature: "0xS" });
    assert.equal(third.message.id, 3, "message ids do not restart at 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
