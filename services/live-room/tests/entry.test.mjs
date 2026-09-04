// P0 entry journey + P1 help/support/legal.
//
// The gate must be explicit about what it is: an interface control on unaudited
// testnet software with valueless collateral. It must not imply legal approval,
// and every acceptance must be recorded against a specific terms version so a
// later version re-prompts rather than silently inheriting consent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EntryGate, TERMS_VERSION, ELIGIBILITY_ATTESTATIONS } from "../src/entry/entry.mjs";
import { HelpCenter } from "../src/help/help.mjs";
import { Capabilities } from "../src/config/capabilities.mjs";
import { Allowlist } from "../src/api/allowlist.mjs";

function gate({ allowlistEnabled = false, addresses = [] } = {}) {
  return new EntryGate({
    allowlist: new Allowlist({ addresses, enabled: allowlistEnabled }),
    capabilities: new Capabilities({ room: { apiUrl: "https://api", roomId: "r" } }),
    // Mirrors production, which wires the same verifier chat uses.
    verifySignature: async (_address, _message, signature) => signature === "0xGOOD",
  });
}

test("a new visitor is told exactly what they must do, in order", async () => {
  const status = await gate().status(null);
  assert.equal(status.can_enter, false);
  assert.deepEqual(
    status.steps.map((step) => step.id),
    ["connect", "terms", "allowlist", "funding"]
  );
  assert.equal(status.steps[0].state, "required");
  assert.ok(status.steps.every((step) => step.title && step.detail));
});

test("the terms state every attestation a person actually makes", () => {
  const terms = gate().terms();
  assert.equal(terms.version, TERMS_VERSION);
  assert.deepEqual(
    terms.attestations.map((entry) => entry.id),
    ELIGIBILITY_ATTESTATIONS.map((entry) => entry.id)
  );
  for (const attestation of terms.attestations) {
    assert.ok(attestation.label.length > 10, "each attestation is a readable sentence");
  }
  const text = JSON.stringify(terms);
  assert.match(text, /no real-world value/i);
  assert.match(text, /unaudited/i);
  assert.ok(!/licensed|regulated|approved in your jurisdiction/i.test(text), "no legal approval is claimed");
});

test("accepting requires every attestation, not a single blanket tick", async () => {
  const entry = gate();
  const partial = await entry.accept({ address: "0xA", version: TERMS_VERSION, attestations: { age: true } });
  assert.equal(partial.accepted, false);
  assert.match(partial.reason, /every/i);

  const full = await entry.accept({
    address: "0xA",
    version: TERMS_VERSION,
    attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true])),
  });
  assert.equal(full.accepted, true);
  assert.equal((await entry.status("0xA")).steps.find((step) => step.id === "terms").state, "done");
});

test("acceptance is bound to a version, so new terms re-prompt", async () => {
  const entry = gate();
  await entry.accept({
    address: "0xA",
    version: TERMS_VERSION,
    attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true])),
  });
  const stale = await entry.accept({ address: "0xB", version: "terms-0", attestations: {} });
  assert.equal(stale.accepted, false);
  assert.match(stale.reason, /version/i);
});

test("the allowlist step is skipped honestly when the allowlist is off", async () => {
  const off = await gate({ allowlistEnabled: false }).status("0xA");
  const step = off.steps.find((entry) => entry.id === "allowlist");
  assert.equal(step.state, "not_required");
  assert.match(step.detail, /not enabled/i);

  const on = await gate({ allowlistEnabled: true, addresses: [] }).status("0xA");
  assert.equal(on.steps.find((entry) => entry.id === "allowlist").state, "blocked");
});

test("entry is granted only when every required step is done", async () => {
  const entry = gate({ allowlistEnabled: true, addresses: ["0xA"] });
  assert.equal((await entry.status("0xA")).can_enter, false, "terms are still outstanding");

  const all = Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true]));

  // An unsigned acceptance records the journey step but does not open the gate:
  // allowlisted addresses are public, so anyone could otherwise post one.
  await entry.accept({ address: "0xA", version: TERMS_VERSION, attestations: all });
  assert.equal((await entry.status("0xA")).can_enter, false, "an unproven acceptance is not entry");

  await entry.accept({
    address: "0xA",
    version: TERMS_VERSION,
    attestations: all,
    claim: entry.claimFor({ address: "0xA", version: TERMS_VERSION }),
    signature: "0xGOOD",
  });
  assert.equal((await entry.status("0xA")).can_enter, true);
  assert.equal((await entry.status("0xB")).can_enter, false, "another address is unaffected");
});

test("the funding step is honest about what is and is not configured", async () => {
  const withoutFaucet = (await gate().status("0xA")).steps.find((step) => step.id === "funding");
  assert.match(withoutFaucet.detail, /not configured/i);

  const withFaucet = new EntryGate({
    allowlist: new Allowlist({ enabled: false }),
    capabilities: new Capabilities({
      room: { apiUrl: "https://api", roomId: "r" },
      funding: { faucetUrl: "https://faucet.circle.com" },
    }),
  });
  const step = (await withFaucet.status("0xA")).steps.find((entry) => entry.id === "funding");
  assert.equal(step.url, "https://faucet.circle.com");
  assert.match(step.detail, /test USDC/i);
});

test("the gate never claims gas sponsorship it does not have", async () => {
  const status = await gate().status("0xA");
  assert.match(status.gas_statement, /pay your own gas/i);
  assert.ok(!/(is|are) sponsored/i.test(status.gas_statement));
});

// ------------------------------------------------------------------ help

test("the help centre is searchable and every article has real content", () => {
  const help = new HelpCenter();
  const all = help.list();
  assert.ok(all.categories.length >= 4);
  const articles = all.categories.flatMap((category) => category.articles);
  assert.ok(articles.length >= 12);
  for (const article of articles) {
    assert.ok(article.slug && article.title, "every article is addressable");
    assert.ok(article.body.length > 80, `${article.slug} needs real content`);
    assert.equal(article.route, `/help/${article.slug}`);
  }
});

test("search finds articles by title and body, and reports misses honestly", () => {
  const help = new HelpCenter();
  const hits = help.search("liquidity");
  assert.ok(hits.results.length > 0);
  assert.ok(hits.results.every((item) => item.slug));

  const miss = help.search("zzzzz-nothing");
  assert.deepEqual(miss.results, []);
  assert.match(miss.empty_reason, /no article/i);
});

test("the help centre explains TraderMarket's differentiators, accurately", () => {
  const help = new HelpCenter();
  const body = help.list().categories.flatMap((c) => c.articles).map((a) => `${a.title} ${a.body}`).join(" ");
  assert.match(body, /0\.3%/, "the LP fee is explained");
  assert.match(body, /1%/, "the winning-participant reward is explained");
  assert.match(body, /Integrity Bond/i);
  assert.match(body, /challenge/i);
  assert.match(body, /invalid/i);
  assert.match(body, /livestream/i);
  assert.match(body, /restricted/i, "participant and insider restrictions are explained");
});

test("legal articles disclaim rather than reassure", () => {
  const help = new HelpCenter();
  const legal = help.article("legal-and-eligibility");
  assert.ok(legal);
  assert.match(legal.body, /no real-world value/i);
  assert.match(legal.body, /unaudited/i);
  assert.ok(!/licensed|regulated|approved/i.test(legal.body.replace(/not (licensed|regulated|approved)/gi, "")));
});

test("an unproven acceptance is recorded as unproven, not as an affirmation", async () => {
  const allowlist = new Allowlist({ addresses: [], enabled: false });
  const gate = new EntryGate({ allowlist, capabilities: new Capabilities({ room: { apiUrl: "http://x" } }) });

  // The terms record says a specific address affirmed statements about their
  // own age, risk understanding and jurisdiction. Anyone can POST any address,
  // so without a signature the record is a claim about a person made by someone
  // else — which must not be presented as their affirmation.
  const unproven = await gate.accept({
    address: "0xSOMEONE",
    version: TERMS_VERSION,
    attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((entry) => [entry.id, true])),
  });

  assert.equal(unproven.accepted, true, "the journey still proceeds — this is an interface control");
  assert.equal(unproven.proven, false);
  assert.match(unproven.notice, /not.*(proven|verified|signature)/i);

  const status = await gate.status("0xSOMEONE");
  const terms = status.steps.find((step) => step.id === "terms");
  assert.match(terms.detail, /not.*(proven|verified|signature)|self-declared/i);
});

test("an acceptance carrying a verified signature is recorded as proven", async () => {
  const allowlist = new Allowlist({ addresses: [], enabled: false });
  const gate = new EntryGate({
    allowlist,
    capabilities: new Capabilities({ room: { apiUrl: "http://x" } }),
    verifySignature: async (_address, _message, signature) => signature === "0xGOOD",
  });

  const claim = gate.claimFor({ address: "0xSOMEONE", version: TERMS_VERSION });
  assert.match(claim, /tradermarket-terms/);
  assert.match(claim, new RegExp(TERMS_VERSION));

  const proven = await gate.accept({
    address: "0xSOMEONE",
    version: TERMS_VERSION,
    attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((entry) => [entry.id, true])),
    claim,
    signature: "0xGOOD",
  });
  assert.equal(proven.accepted, true);
  assert.equal(proven.proven, true);

  const forged = await gate.accept({
    address: "0xSOMEONE",
    version: TERMS_VERSION,
    attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((entry) => [entry.id, true])),
    claim,
    signature: "0xBAD",
  });
  assert.equal(forged.accepted, false, "a signature that does not verify is a refusal, not an unproven accept");
});

test("the client's terms claim matches the service's, field for field", async () => {
  const { termsClaim } = await import(
    "../../../prototype/live-market-app/src/chat-claim.js"
  );
  const gate = new EntryGate({
    allowlist: new Allowlist({ enabled: false }),
    capabilities: new Capabilities({ room: { apiUrl: "http://x" } }),
  });

  assert.equal(
    termsClaim({ address: "0xAbC", version: TERMS_VERSION }),
    gate.claimFor({ address: "0xAbC", version: TERMS_VERSION }),
    "a drift here refuses every acceptance with 'the signed statement does not match'"
  );
});

test("an unproven acceptance does not open the API gate for that address", async () => {
  const allowlist = new Allowlist({ addresses: ["0xallowed"], enabled: true });
  const gate = new EntryGate({
    allowlist,
    capabilities: new Capabilities({ room: { apiUrl: "http://x" } }),
    verifySignature: async (_a, _m, signature) => signature === "0xGOOD",
  });
  const all = Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((entry) => [entry.id, true]));

  // Allowlisted addresses are public — they trade on chain. Writing an unproven
  // acceptance into the object that gates the API means a stranger can post
  // someone else's address, then assert it in a header, and be let in.
  const unproven = await gate.accept({ address: "0xallowed", version: TERMS_VERSION, attestations: all });
  assert.equal(unproven.accepted, true, "the journey still proceeds");
  assert.equal(unproven.proven, false);
  assert.equal(
    (await allowlist.check("0xallowed")).allowed,
    false,
    "but an unproven acceptance must not satisfy the gate"
  );

  const proven = await gate.accept({
    address: "0xallowed",
    version: TERMS_VERSION,
    attestations: all,
    claim: gate.claimFor({ address: "0xallowed", version: TERMS_VERSION }),
    signature: "0xGOOD",
  });
  assert.equal(proven.proven, true);
  assert.equal((await allowlist.check("0xallowed")).allowed, true, "a signed acceptance does satisfy it");
});

test("the entry status says the gate still needs a signature", async () => {
  const allowlist = new Allowlist({ addresses: ["0xallowed"], enabled: true });
  const gate = new EntryGate({ allowlist, capabilities: new Capabilities({ room: { apiUrl: "http://x" } }) });
  const all = Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((entry) => [entry.id, true]));

  await gate.accept({ address: "0xallowed", version: TERMS_VERSION, attestations: all });
  const step = (await gate.status("0xallowed")).steps.find((entry) => entry.id === "allowlist");

  assert.match(step.detail, /sign/i, "the reader must be told why they are still gated");
});

test("a build that cannot verify says so, rather than blaming the signature", async () => {
  const gate = new EntryGate({
    allowlist: new Allowlist({ enabled: false }),
    capabilities: new Capabilities({ room: { apiUrl: "http://x" } }),
    // No verifier configured.
  });
  const result = await gate.accept({
    address: "0xA",
    version: TERMS_VERSION,
    attestations: Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true])),
    claim: gate.claimFor({ address: "0xA", version: TERMS_VERSION }),
    signature: "0xANY",
  });

  assert.equal(result.accepted, false);
  assert.match(
    result.reason,
    /cannot (verify|check)/i,
    "asserting the signature is wrong is a claim about a check that never ran"
  );
});

test("a signature can be added after an unsigned acceptance", async () => {
  const entry = gate({ allowlistEnabled: true, addresses: ["0xA"] });
  const all = Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true]));

  // Declining the wallet prompt once must not lock the address out. The
  // acceptance is recorded unproven; signing later must upgrade it.
  await entry.accept({ address: "0xA", version: TERMS_VERSION, attestations: all });
  assert.equal((await entry.status("0xA")).can_enter, false);

  const signed = await entry.accept({
    address: "0xA",
    version: TERMS_VERSION,
    attestations: all,
    claim: entry.claimFor({ address: "0xA", version: TERMS_VERSION }),
    signature: "0xGOOD",
  });
  assert.equal(signed.proven, true);
  assert.equal((await entry.status("0xA")).can_enter, true, "signing later must open the gate");
});

test("a stranger's unsigned post cannot downgrade a proven acceptance", async () => {
  const entry = gate({ allowlistEnabled: true, addresses: ["0xA"] });
  const all = Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((item) => [item.id, true]));

  await entry.accept({
    address: "0xA",
    version: TERMS_VERSION,
    attestations: all,
    claim: entry.claimFor({ address: "0xA", version: TERMS_VERSION }),
    signature: "0xGOOD",
  });
  assert.equal((await entry.status("0xA")).can_enter, true);

  // Anyone can POST this. It must not take away what the real owner proved.
  await entry.accept({ address: "0xA", version: TERMS_VERSION, attestations: all });
  assert.equal((await entry.status("0xA")).can_enter, true, "a stranger cannot revoke a proven acceptance");
  const step = (await entry.status("0xA")).steps.find((s) => s.id === "terms");
  assert.match(step.detail, /signed/i, "and it must still be reported as signed");
});
