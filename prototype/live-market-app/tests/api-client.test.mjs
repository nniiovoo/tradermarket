// The website's API client. Every consumer surface needs three honest states —
// loading, error with a retry, and empty — and must never present an outage or
// an unconfigured deployment as real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApiClient, ApiError } from "../src/api/client.js";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

test("an unconfigured client reports unconfigured rather than failing", async () => {
  const client = createApiClient({ baseUrl: "" });
  assert.equal(client.configured, false);
  const result = await client.get("/v1/activity");
  assert.equal(result.ok, false);
  assert.equal(result.unconfigured, true);
  assert.match(result.error, /not configured/i);
  assert.equal(result.data, null, "no data is invented for an unconfigured client");
});

test("a successful call returns data with ok:true", async () => {
  await withServer((request, response) => json(response, 200, { hello: "world" }), async (base) => {
    const client = createApiClient({ baseUrl: base });
    const result = await client.get("/v1/anything");
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { hello: "world" });
  });
});

test("a 403 surfaces the gate's own copy, and is not treated as an outage", async () => {
  await withServer(
    (request, response) => json(response, 403, { allowed: false, reason: "not allowlisted", copy: "Interface only." }),
    async (base) => {
      const client = createApiClient({ baseUrl: base });
      const result = await client.get("/v1/rooms/x");
      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
      assert.equal(result.denied, true);
      assert.equal(result.copy, "Interface only.");
      assert.ok(!result.retryable, "a denial is not something to retry");
    }
  );
});

test("a 404 is distinguished from an outage", async () => {
  await withServer((request, response) => json(response, 404, { error: "no such article" }), async (base) => {
    const client = createApiClient({ baseUrl: base });
    const result = await client.get("/v1/help/nope");
    assert.equal(result.notFound, true);
    assert.equal(result.retryable, false);
  });
});

test("a server error is retryable and says so", async () => {
  let calls = 0;
  await withServer(
    (request, response) => {
      calls += 1;
      json(response, 500, { error: "boom" });
    },
    async (base) => {
      const client = createApiClient({ baseUrl: base });
      const result = await client.get("/v1/activity");
      assert.equal(result.ok, false);
      assert.equal(result.retryable, true);
      assert.equal(calls, 1, "the client does not silently hammer a failing server");
    }
  );
});

test("an unreachable server is retryable, not fatal", async () => {
  const client = createApiClient({ baseUrl: "http://127.0.0.1:1" });
  const result = await client.get("/v1/activity");
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.error, /unreachable|refused|fetch/i);
});

test("the address header is sent when an account is known", async () => {
  const seen = [];
  await withServer(
    (request, response) => {
      seen.push(request.headers["x-tm-address"]);
      json(response, 200, {});
    },
    async (base) => {
      const client = createApiClient({ baseUrl: base, getAddress: () => "0xME" });
      await client.get("/v1/entry/status");
      assert.deepEqual(seen, ["0xME"]);
    }
  );
});

test("posts carry JSON and surface validation failures with their body", async () => {
  await withServer(
    (request, response) => json(response, 400, { accepted: false, reason: "every attestation must be affirmed" }),
    async (base) => {
      const client = createApiClient({ baseUrl: base });
      const result = await client.post("/v1/entry/accept", { address: "0xA" });
      assert.equal(result.ok, false);
      assert.equal(result.data.reason, "every attestation must be affirmed");
      assert.equal(result.retryable, false, "a validation failure is not retried");
    }
  );
});

test("livestream proof uploads keep the clip binary and put canonical metadata in the URL", async () => {
  const seen = {};
  await withServer(
    async (request, response) => {
      seen.url = request.url;
      seen.type = request.headers["content-type"];
      seen.token = request.headers["x-tm-oracle-token"];
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      seen.body = Buffer.concat(chunks);
      json(response, 201, { evidence_hash: `0x${"a".repeat(64)}` });
    },
    async (base) => {
      const client = createApiClient({ baseUrl: base });
      const clip = Buffer.from("mp4-proof");
      const result = await client.uploadLivestreamProof(
        {
          market: "0x1111111111111111111111111111111111111111",
          outcome: 1,
          sourceSequence: 42,
          streamUrl: "https://twitch.tv/example",
          occurredAt: "2026-08-22T20:15:04.000Z",
          clipStartMs: 12000,
          clipEndMs: 32000,
          rule: "First guest appears first.",
          rationale: "Visible at the first qualifying frame.",
        },
        clip,
        "secret-token"
      );
      assert.equal(result.ok, true);
      assert.match(seen.url, /^\/v1\/oracle\/proofs\?/);
      assert.match(seen.url, /source_sequence=42/);
      assert.match(seen.url, /rule=First\+guest\+appears\+first/);
      assert.equal(seen.type, "video/mp4");
      assert.equal(seen.token, "secret-token");
      assert.deepEqual(seen.body, clip);
    }
  );
});

test("a stale response never overwrites a newer one", async () => {
  const { createRequestSequencer } = await import("../src/hooks/useApiResource.js");

  // Navigating from one settled market to another issues two reads. If the
  // first resolves last, its data lands under the second market's URL — the app
  // then shows one market's settlement record as another's, which is the single
  // worst thing this surface could get wrong.
  const sequencer = createRequestSequencer();
  const first = sequencer.begin();
  const second = sequencer.begin();

  assert.equal(sequencer.isCurrent(second), true, "the newest request is the one that counts");
  assert.equal(sequencer.isCurrent(first), false, "an older request must not be applied");

  const third = sequencer.begin();
  assert.equal(sequencer.isCurrent(second), false);
  assert.equal(sequencer.isCurrent(third), true);
});
