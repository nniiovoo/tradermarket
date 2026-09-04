// Referral attribution.
//
// Codes existed and the count was hardcoded to zero — honest, but a programme
// that can never attribute anything is not a programme. Attribution here is a
// two-part fact, and both parts are verifiable:
//
//   1. the referred person signs a claim naming the code, which proves the
//      binding came from them and not from whoever wanted the credit;
//   2. their first market action appears on chain *after* that binding, which
//      is what makes it a referral rather than a retro-claim on someone who
//      was already trading.
//
// No reward is paid by this: nothing funds one. The count is a count.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Growth } from "../src/growth/growth.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { Capabilities } from "../src/config/capabilities.mjs";
import { openDatabase, SqliteReferralStore } from "../src/ports/sqlite-stores.mjs";

const REFERRER = "0xREFERRER000000000000000000000000000000AA";
const FRIEND = "0xFRIEND0000000000000000000000000000000BB";

const enabled = () =>
  new Capabilities({
    room: { apiUrl: "http://x" },
    referrals: { enabled: true, programId: "testnet-1" },
  });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-ref-"));
  return { store: new SqliteReferralStore(openDatabase(join(dir, "room.db"))), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a binding needs a signature from the person being referred", async () => {
  const { store, clean } = scratch();
  try {
    const growth = new Growth({
      capabilities: enabled(),
      store: new ProjectionStore(),
      referrals: store,
      verifySignature: async (_address, _message, signature) => signature === "0xGOOD",
    });
    const code = (await growth.referrals(REFERRER)).code;

    // Anyone can post anyone's address, so an unsigned binding would let a
    // stranger claim credit for a person who never heard of them.
    const unsigned = await growth.bindReferral({ address: FRIEND, code });
    assert.equal(unsigned.ok, false);
    assert.match(unsigned.reason, /sign/i);

    const claim = growth.referralClaimFor({ address: FRIEND, code });
    assert.match(claim, /tradermarket-referral-v1/);
    assert.match(claim, new RegExp(code));
    assert.match(claim, new RegExp(REFERRER.toLowerCase()), "the referred person attests who referred them");

    const forged = await growth.bindReferral({ address: FRIEND, code, claim, signature: "0xBAD" });
    assert.equal(forged.ok, false);

    const bound = await growth.bindReferral({ address: FRIEND, code, claim, signature: "0xGOOD" });
    assert.equal(bound.ok, true);
  } finally {
    clean();
  }
});

test("nobody can be referred twice, or refer themselves", async () => {
  const { store, clean } = scratch();
  try {
    const growth = new Growth({
      capabilities: enabled(),
      store: new ProjectionStore(),
      referrals: store,
      verifySignature: async () => true,
    });
    const code = (await growth.referrals(REFERRER)).code;
    const bind = (address, withCode = code) =>
      growth.bindReferral({
        address,
        code: withCode,
        claim: growth.referralClaimFor({ address, code: withCode }),
        signature: "0xS",
      });

    assert.equal((await bind(FRIEND)).ok, true);
    const again = await bind(FRIEND);
    assert.equal(again.ok, false, "a second binding would let someone shop for a referrer");
    assert.match(again.reason, /already/i);

    const self = await bind(REFERRER);
    assert.equal(self.ok, false, "referring yourself is not a referral");
    assert.match(self.reason, /own/i);
  } finally {
    clean();
  }
});

test("a binding is attributed only once the referred address actually trades", async () => {
  const { store, clean } = scratch();
  const projections = new ProjectionStore();
  try {
    const growth = new Growth({
      capabilities: enabled(),
      store: projections,
      referrals: store,
      verifySignature: async () => true,
    });
    const code = (await growth.referrals(REFERRER)).code;
    await growth.bindReferral({
      address: FRIEND,
      code,
      claim: growth.referralClaimFor({ address: FRIEND, code }),
      signature: "0xS",
      atBlock: 100,
    });

    assert.equal((await growth.referrals(REFERRER)).referred, 0, "a binding on its own is a hope, not a referral");
    assert.equal((await growth.referrals(REFERRER)).bound, 1, "but it is counted as what it is");

    // A trade from before the binding does not count: it is a retro-claim on
    // somebody who was already here.
    projections.appendTrade({
      market_address: "0xM", account: FRIEND, outcome_a: true, is_buy: true,
      amount_in: 5n, amount_out: 9n, block_number: 50,
    });
    assert.equal(
      (await growth.referrals(REFERRER)).referred,
      0,
      "a trade that predates the binding is not attributable"
    );

    projections.appendTrade({
      market_address: "0xM", account: FRIEND, outcome_a: true, is_buy: true,
      amount_in: 5n, amount_out: 9n, block_number: 120,
    });
    const attributed = await growth.referrals(REFERRER);
    assert.equal(attributed.referred, 1, "a first action after the binding is the referral");
    assert.match(attributed.attribution_note, /on chain/i);
  } finally {
    clean();
  }
});

test("attribution survives a restart, because a referral is not a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-ref-"));
  const path = join(dir, "room.db");
  const projections = new ProjectionStore();
  try {
    const build = () =>
      new Growth({
        capabilities: enabled(),
        store: projections,
        referrals: new SqliteReferralStore(openDatabase(path)),
        verifySignature: async () => true,
      });

    const before = build();
    const code = (await before.referrals(REFERRER)).code;
    await before.bindReferral({
      address: FRIEND, code,
      claim: before.referralClaimFor({ address: FRIEND, code }),
      signature: "0xS", atBlock: 10,
    });
    projections.appendTrade({
      market_address: "0xM", account: FRIEND, outcome_a: true, is_buy: true,
      amount_in: 5n, amount_out: 9n, block_number: 20,
    });

    const after = build();
    assert.equal((await after.referrals(REFERRER)).referred, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no referral store the count stays zero and says why", async () => {
  const growth = new Growth({ capabilities: enabled(), store: new ProjectionStore() });
  const view = await growth.referrals(REFERRER);
  assert.equal(view.referred, 0);
  assert.match(view.attribution_note, /not recorded|no attribution/i);
});

test("the HTTP surface binds a signed referral and refuses an unsigned one", async () => {
  const { buildService, configFromEnv } = await import("../src/app.mjs");
  const dir = mkdtempSync(join(tmpdir(), "tm-ref-api-"));
  try {
    const service = buildService(
      configFromEnv({
        TM_ROOMS: "alpha=0x2222222222222222222222222222222222222222",
        TM_RPC_URL: "http://127.0.0.1:8545",
        TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
        TM_CHAIN_ID: "31337",
        TM_ROOM_API_URL: "http://127.0.0.1:8787",
        TM_DATA_DIR: dir,
        TM_REFERRALS_ENABLED: "true",
        TM_REFERRAL_PROGRAM_ID: "testnet-1",
      }),
      { verifySignature: async (_a, _m, signature) => signature === "0xGOOD" }
    );
    try {
      const address = await service.server.listen(0);
      const base = `http://127.0.0.1:${address.port}`;
      const post = (body) =>
        fetch(`${base}/v1/referrals/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const view = await (await fetch(`${base}/v1/referrals/${REFERRER}`)).json();
      assert.equal(view.available, true);
      assert.equal(view.referred, 0);

      const claim = service.growth.referralClaimFor({ address: FRIEND, code: view.code });
      assert.equal((await post({ address: FRIEND, code: view.code, claim })).status, 400, "unsigned is refused");

      const bound = await post({ address: FRIEND, code: view.code, claim, signature: "0xGOOD" });
      assert.equal(bound.status, 200);

      const after = await (await fetch(`${base}/v1/referrals/${REFERRER}`)).json();
      assert.equal(after.bound, 1, "the binding is recorded");
      assert.equal(after.referred, 0, "and is not a referral until they act on chain");
    } finally {
      await service.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
