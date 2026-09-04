import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildService, configFromEnv } from "../src/app.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";

const ROOM = "0x2222222222222222222222222222222222222222";
const MARKET = "0x3333333333333333333333333333333333333333";
const TAMPERED_MARKET = "0x4444444444444444444444444444444444444444";
const CONDITION = {
  condition_version: "1.0.0",
  template: "first_to_realized_pnl",
  params: { target: "1000" },
};

test("the production settlement API hydrates a published condition from the durable queue", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tm-settlement-hydration-"));
  const service = buildService(
    configFromEnv({
      TM_RPC_URL: "http://127.0.0.1:8545",
      TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
      TM_ROOM_ID: "alpha",
      TM_ROOM_ADDRESS: ROOM,
      TM_PARTICIPANT_A: "alice",
      TM_PARTICIPANT_B: "bob",
      TM_DATA_DIR: dataDir,
    })
  );
  try {
    const queue = new SqlitePublicationQueue(service.database, "alpha");
    const { id } = await queue.submit({ templateId: "headline", params: { target: "1000" } });
    await queue.markAwaitingPermit(id, { request: {}, restricted: [], conditionDocument: CONDITION });
    await queue.markPublished(id, { market: MARKET });

    service.store.upsertRoom({ room_id: "alpha", live_room_address: ROOM, closed_source_seq: 1, state: "final" });
    service.store.upsertSlot({
      room_id: "alpha",
      slot_index: 0,
      market_address: MARKET,
      question: "Who reaches $1,000 first?",
      condition_hash: conditionHash(CONDITION),
      state: "final",
    });
    service.store.upsertMarket({ market_address: MARKET, room_id: "alpha", slot_index: 0, final_outcome: 1 });
    await service.eventLog.append({
      seq: 1,
      room_id: "alpha",
      participant: "alice",
      kind: "trade_closed",
      source_event_id: "fill-1",
      observed_at: "2026-08-22T00:00:00.000Z",
      hash: "0xf1",
      facts: { realized_pnl_usd: "1000" },
    });

    const record = await service.settlement.record(MARKET);
    assert.deepEqual(record.closing_condition, CONDITION);
    assert.deepEqual(record.decisive_event, { seq: 1, outcome: "alice" });
    assert.deepEqual(record.replay.log_range, { from: 1, to: 1 });

    const tampered = { ...CONDITION, params: { target: "1" } };
    const second = await queue.submit({ templateId: "headline", params: { target: "1" } });
    await queue.markAwaitingPermit(second.id, { request: {}, restricted: [], conditionDocument: tampered });
    await queue.markPublished(second.id, { market: TAMPERED_MARKET });
    service.store.upsertSlot({
      room_id: "alpha",
      slot_index: 1,
      market_address: TAMPERED_MARKET,
      condition_hash: conditionHash(CONDITION),
      state: "final",
    });
    service.store.upsertMarket({ market_address: TAMPERED_MARKET, room_id: "alpha", slot_index: 1, final_outcome: 1 });
    assert.equal(
      (await service.settlement.record(TAMPERED_MARKET)).closing_condition,
      null,
      "a durable queue record is transport, not authority over the on-chain condition hash"
    );
  } finally {
    service.database.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
