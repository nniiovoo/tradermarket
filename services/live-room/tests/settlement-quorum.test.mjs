// The resolver quorum on a settlement record must reflect the chain.
//
// The defect this pins: quorum was derived only from an optional off-chain
// `chainRefs` map. A service that indexes a real chain — and therefore holds
// the real ResultAttested events — reported "quorum: not reached" on a market
// that two resolvers had in fact attested to and that had already finalized.
//
// That is the single most trust-critical field on the settlement page: it is
// the claim that the result was independently reconstructed. Reporting it false
// where it is true tells a reader the market settled without agreement.

import test from "node:test";
import assert from "node:assert/strict";

import { SettlementService } from "../src/settlement/settlement.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { MemoryEventStore } from "../src/ports/stores.mjs";

const MARKET = "0xMARKET";

function seeded() {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET,
    room_id: "room-1",
    slot_index: 0,
    question: "Who wins?",
    final_outcome: 1,
    finalized_block_number: 40,
    participant_a_name: "Alice",
    participant_b_name: "Bob",
    block_number: 40,
  });
  store.appendAttestation({
    market_address: MARKET,
    resolver: "0xR1",
    outcome: 1,
    evidence_hash: "0xe1",
    count: 1,
    block_number: 38,
  });
  store.appendAttestation({
    market_address: MARKET,
    resolver: "0xR2",
    outcome: 1,
    evidence_hash: "0xe1",
    count: 2,
    block_number: 39,
  });
  return store;
}

function service(store, chainRefs = new Map()) {
  return new SettlementService({
    store,
    eventLog: new MemoryEventStore(),
    conditions: new Map(),
    participantKeys: { a: "alice", b: "bob" },
    chainRefs,
  });
}

test("quorum comes from the indexed attestations when no off-chain refs exist", async () => {
  const record = await service(seeded()).record(MARKET);

  assert.equal(record.resolution.quorum, true, "two indexed attestations are a reached quorum");
  assert.equal(record.resolution.attestations.length, 2);
  assert.equal(record.resolution.attestations[0].resolver, "0xR1");
});

test("the settlement record freezes human outcome labels and names the winner", async () => {
  const record = await service(seeded()).record(MARKET);

  assert.deepEqual(record.participants, { a: "Alice", b: "Bob" });
  assert.equal(record.resolution.winner_name, "Alice");
  assert.equal(record.chain.finalized_block, 40);
});

test("the settlement record preserves honest unknown participant labels", async () => {
  const store = seeded();
  store.upsertMarket({ market_address: MARKET, participant_a_name: null, participant_b_name: null });

  const record = await service(store).record(MARKET);
  assert.deepEqual(record.participants, { a: null, b: null });
  assert.equal(record.resolution.winner_name, null);
});

test("a single attestation is not a quorum", async () => {
  const store = seeded();
  store.attestations = store.attestations.slice(0, 1);

  assert.equal((await service(store).record(MARKET)).resolution.quorum, false);
});

test("attestations for another market never count towards this one", async () => {
  const store = seeded();
  store.appendAttestation({
    market_address: "0xOTHER",
    resolver: "0xR3",
    outcome: 2,
    evidence_hash: "0xe9",
    count: 1,
    block_number: 41,
  });

  const record = await service(store).record(MARKET);
  assert.equal(record.resolution.attestations.length, 2, "only this market's attestations count");
});

test("explicit chain refs still win, so a curated record is not overwritten", async () => {
  const refs = new Map([
    [MARKET, { attestations: [{ resolver: "0xCURATED", tx: "0xa1" }] }],
  ]);
  const record = await service(seeded(), refs).record(MARKET);

  assert.equal(record.resolution.attestations.length, 1);
  assert.equal(record.resolution.attestations[0].resolver, "0xCURATED");
  assert.equal(record.resolution.quorum, false, "one curated attestation is still not a quorum");
});

test("quorum means two resolvers on the same result, not two rows", async () => {
  // The chain's rule is resultAttestationCount[keccak256(outcome, evidenceHash)]
  // == 2 — two resolvers agreeing on the same reconstruction. Counting rows
  // instead reports a reached quorum for two resolvers who disagreed, on a
  // market that finalized Invalid precisely because they did.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET,
    room_id: "room-1",
    slot_index: 0,
    question: "Who wins?",
    final_outcome: 4,
    block_number: 40,
  });
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR1", outcome: 1,
    evidence_hash: "0xe1", count: 1, block_number: 38,
  });
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR2", outcome: 2,
    evidence_hash: "0xe2", count: 1, block_number: 39,
  });

  const record = await service(store).record(MARKET);
  assert.equal(record.resolution.quorum, false, "resolvers who disagreed did not reach quorum");
  assert.equal(record.resolution.attestations.length, 2, "both attestations are still reported");
  assert.match(record.invalidation.explanation, /never attested to the same result/i);
});

test("one resolver attesting twice is not a quorum", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET, room_id: "room-1", slot_index: 0,
    question: "Who wins?", final_outcome: 1, block_number: 40,
  });
  // The chain dedups per (outcome, evidenceHash) per resolver, so one resolver
  // can legitimately emit two events with different outcomes.
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR1", outcome: 1,
    evidence_hash: "0xe1", count: 1, block_number: 38,
  });
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR1", outcome: 2,
    evidence_hash: "0xe2", count: 1, block_number: 39,
  });

  assert.equal((await service(store).record(MARKET)).resolution.quorum, false);
});

test("two resolvers on the same reconstruction do reach quorum", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET, room_id: "room-1", slot_index: 0,
    question: "Who wins?", final_outcome: 1, block_number: 40,
  });
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR1", outcome: 1,
    evidence_hash: "0xe1", count: 1, block_number: 38,
  });
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR2", outcome: 1,
    evidence_hash: "0xe1", count: 2, block_number: 39,
  });

  assert.equal((await service(store).record(MARKET)).resolution.quorum, true);
});

test("claimsFor states what is owed, not merely what is held", () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET, room_id: "room-1", slot_index: 0,
    question: "Who wins?", final_outcome: 1, block_number: 40,
  });
  // Held only the losing side: redeeming pays zero, so nothing is owed.
  store.adjustHolding(MARKET, "0xloser", { position_b: 500n }, 41);
  store.adjustHolding(MARKET, "0xwinner", { position_a: 500n }, 41);

  const loser = service(store).claimsFor("0xloser")[0];
  assert.equal(loser.claimable, false, "a losing holding is not a claim");
  assert.equal(loser.redeemable_value, "0");

  const winner = service(store).claimsFor("0xwinner")[0];
  assert.equal(winner.claimable, true);
  assert.equal(winner.redeemable_value, "500");
});

test("an invalidation reason is only given when it is known", async () => {
  // The record hardcoded "no_quorum" for every Invalid market, so a market
  // invalidated by a persistent skip, a stalled gate, or a challenge that was
  // never reviewed was reported as resolvers failing to agree — and the record
  // said so beside a quorum field showing they had.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET, room_id: "room-1", slot_index: 0,
    question: "Q", final_outcome: 4, block_number: 40,
  });
  // Two resolvers agreed; the market went Invalid for some other reason.
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR1", outcome: 1, evidence_hash: "0xe1", count: 1, block_number: 38,
  });
  store.appendAttestation({
    market_address: MARKET, resolver: "0xR2", outcome: 1, evidence_hash: "0xe1", count: 2, block_number: 39,
  });

  const record = await service(store).record(MARKET);
  assert.equal(record.resolution.quorum, true);
  assert.notEqual(
    record.invalidation.reason_code,
    "no_quorum",
    "the record must not blame resolvers who agreed"
  );
  assert.match(record.invalidation.explanation, /not recorded|unknown|cannot/i);
});

test("a persistent skip is named as the reason it is", async () => {
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET, room_id: "room-1", slot_index: 0,
    question: "Q", final_outcome: 4, block_number: 40,
  });
  store.appendSkip({ market: MARKET, epoch: 1n, selector: "0xabc", reason: "0x", block_number: 12 });
  store.appendSkip({ market: MARKET, epoch: 2n, selector: "0xabc", reason: "0x", block_number: 13 });

  const record = await service(store).record(MARKET);
  assert.equal(record.invalidation.reason_code, "persistent_skip");
});

test("claimsFor reports what an LP position actually settles for", () => {
  // settleLpInventory pays real collateral for LP shares, so reporting
  // redeemable_value 0 for an LP tells them their inventory is worthless.
  const store = new ProjectionStore();
  store.upsertMarket({
    market_address: MARKET, room_id: "room-1", slot_index: 0,
    question: "Q", final_outcome: 1, reserve_a: 400n, reserve_b: 600n,
    total_lp_shares: 1_000n, block_number: 40,
  });
  store.adjustHolding(MARKET, "0xlp", { lp_shares: 500n }, 41);

  const row = service(store).claimsFor("0xlp")[0];
  assert.equal(row.claimable, true);
  assert.ok(
    row.lp_inventory_note && /settle/i.test(row.lp_inventory_note),
    "an LP position settles separately and the record should say so"
  );
  assert.equal(row.redeemable_value, "0", "no positions were held");
  assert.equal(row.lp_shares, "500");
});

// ---------------------------------------------------------------------------
// A settlement record has to show the evidence the result was reached on.
//
// The deciding events were read straight out of the log by sequence, so a fact
// the provider later restated appeared at its withdrawn value — and a
// restatement that arrived after the decisive sequence did not appear at all.
// The record then published one figure as the reason for a result reached on
// another, which is worse than publishing nothing: it looks like proof.

test("the deciding events show corrected facts, and say they were corrected", async () => {
  const { SourceConnector } = await import("../src/connector/connector.mjs");
  const { MemoryRawArchive } = await import("../src/ports/stores.mjs");
  const { normalizeFillsResponse } = await import("../src/connector/hyperliquid.mjs");
  const { privateKeyToAccount } = await import("viem/accounts");

  const eventLog = new MemoryEventStore();
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store: eventLog,
    rawArchive: new MemoryRawArchive(),
    signer: privateKeyToAccount("0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82"),
    clock: () => new Date().toISOString(),
  });
  const address = "0x000000000000000000000000000000000000000a";
  const post = async (fills, endTime) =>
    connector.ingestBatch({
      rawBytes: JSON.stringify(fills),
      rawQuery: { endpoint: "info", type: "userFillsByTime", user: address, startTime: 0, endTime },
      drafts: normalizeFillsResponse("alice", address, fills),
    });
  const fill = (tid, time, closedPnl) => ({ tid, time, closedPnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" });

  await post([fill(1, 1_000, "9000")], 2_000);
  await post([fill(2, 2_000, "2000")], 3_000);
  await post([fill(1, 1_000, "5000")], 4_000); // restated after the fact

  const store = seeded();
  const condition = {
    condition_version: "1.0.0",
    template: "participant_metric_threshold",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "7000" },
  };
  const settlement = new SettlementService({
    store,
    eventLog,
    conditions: new Map([[MARKET, condition]]),
    participantKeys: { a: "alice", b: "bob" },
    chainRefs: new Map(),
  });

  const record = await settlement.record(MARKET);
  const shown = record.deciding_events.filter((event) => event.kind === "trade_closed");
  const first = shown.find((event) => event.facts.tid === 1);

  assert.equal(first.facts.realized_pnl_usd, "5000", "the withdrawn 9000 must not be published as evidence");
  assert.equal(first.corrected, true, "and the record has to say the figure was restated");
  assert.equal(shown.length, 2, "one fact per trade, not one per report of it");
});

test("a settlement record cannot state an outcome the market did not pay", async () => {
  // The room's closing sequence can sit past the terminal fill — deliberately,
  // because a retroactive decision must still close at a sequence the chain
  // accepts. A replay bounded by that sequence sees fills the resolver dropped.
  // On a market that already paid, publishing the other answer beside the
  // payout is worse than publishing nothing.
  const { SourceConnector } = await import("../src/connector/connector.mjs");
  const { MemoryRawArchive } = await import("../src/ports/stores.mjs");
  const { normalizeFillsResponse } = await import("../src/connector/hyperliquid.mjs");
  const { ResolverNode } = await import("../src/resolver/resolver.mjs");
  const { privateKeyToAccount } = await import("viem/accounts");

  const ALICE = "0x000000000000000000000000000000000000000a";
  const BOB = "0x000000000000000000000000000000000000000b";
  const eventLog = new MemoryEventStore();
  const rawArchive = new MemoryRawArchive();
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store: eventLog,
    rawArchive,
    signer: privateKeyToAccount("0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82"),
    clock: () => new Date().toISOString(),
  });
  const fill = (tid, time, pnl) => ({ tid, time, closedPnl: pnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" });
  const post = (key, address, fills, endTime) =>
    connector.ingestBatch({
      rawBytes: JSON.stringify(fills),
      rawQuery: { endpoint: "info", type: "userFillsByTime", user: address, startTime: 0, endTime },
      drafts: normalizeFillsResponse(key, address, fills),
    });

  await post("alice", ALICE, [fill(1, 1_000, "3000")], 1_050);
  await post("alice", ALICE, [fill(2, 1_100, "1000")], 1_150);
  await post("bob", BOB, [fill(9, 1_200, "100")], 1_250);
  await post("alice", ALICE, [fill(1, 1_000, "7000")], 900_000); // restatement: headline decided at seq 2

  const HEADLINE_MARKET = "0xHEADLINE";
  const headline = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "8000" } };
  const lateSlot = {
    condition_version: "1.0.0",
    template: "participant_metric_threshold",
    params: { participant: "bob", metric: "realized_pnl_usd", operator: ">=", value: "100" },
  };

  const store = seeded();
  store.upsertMarket({
    market_address: HEADLINE_MARKET,
    room_id: "room-1",
    slot_index: 0,
    question: "Who wins?",
    final_outcome: 1,
    block_number: 40,
  });
  // The room closed at 4: past the terminal fill, which is what the chain needs.
  store.upsertRoom?.({ room_id: "room-1", closed_source_seq: 4 }) ??
    store.rooms.set("room-1", { room_id: "room-1", closed_source_seq: 4 });

  const settlement = new SettlementService({
    store,
    eventLog,
    conditions: new Map([
      [HEADLINE_MARKET, headline],
      [MARKET, lateSlot],
    ]),
    participantKeys: { a: "alice", b: "bob" },
    chainRefs: new Map(),
  });

  const node = new ResolverNode({
    name: "r1",
    rawArchive,
    participants: [
      { key: "alice", address: ALICE },
      { key: "bob", address: BOB },
    ],
    signerChain: null,
  });
  const reconstruction = await node.reconstructFacts(eventLog.all());
  const paid = node.evaluateSlot(lateSlot, headline, reconstruction);

  const record = await settlement.record(MARKET);
  assert.equal(
    record.decisive_event.outcome,
    paid.outcome,
    `the record says ${record.decisive_event.outcome} while the market paid ${paid.outcome}`
  );
  assert.equal(paid.outcome, "no", "bob's fill happened after the session ended");
});

test("a challenged market says so, and says how it went", async () => {
  // The record reported `challenge: null` and "the specific reason is not
  // recorded on chain" for a market that WAS challenged — while this very
  // process held the indexed challenger. That is the same defect already fixed
  // one field above for quorum ("their absence must never read as 'the
  // resolvers never agreed'"), left in place for the field that tells a holder
  // why their position redeemed at half.
  const store = seeded();
  store.upsertMarket({ market_address: MARKET, final_outcome: 4, block_number: 45 });
  store.upsertMarket({
    market_address: MARKET,
    challenger: "0xCHALLENGER",
    challenge_evidence_hash: "0xevidence",
    block_number: 41,
  });

  const filed = await service(store).record(MARKET);
  assert.ok(filed.resolution.challenge, "a bonded challenge is on chain; the record must not say there was none");
  assert.equal(filed.resolution.challenge.challenger, "0xCHALLENGER");
  assert.equal(filed.resolution.challenge.upheld, null, "no verdict is indexed yet, so none is claimed");
  assert.equal(filed.invalidation.reason_code, "challenge_filed");
  assert.doesNotMatch(
    filed.invalidation.explanation,
    /not recorded on chain/,
    "it is recorded on chain — this process indexed it"
  );

  // Once two resolvers attest the verdict, the record can say what it was.
  store.appendChallengeVerdict({
    market_address: MARKET,
    resolver: "0xR1",
    accept_challenge: true,
    count: 1,
    block_number: 46,
  });
  store.appendChallengeVerdict({
    market_address: MARKET,
    resolver: "0xR2",
    accept_challenge: true,
    count: 2,
    block_number: 47,
  });
  const upheld = await service(store).record(MARKET);
  assert.equal(upheld.resolution.challenge.upheld, true);
  assert.equal(upheld.invalidation.reason_code, "challenge_upheld");
});

test("the indexer watches the event the chain emits for a challenge verdict", async () => {
  const { INDEXED_EVENTS, verifyEventCoverage } = await import("../src/indexer/abi.mjs");
  assert.ok(
    JSON.stringify(INDEXED_EVENTS).includes("ChallengeVerdictAttested"),
    "the contract emits it and a settlement record needs it"
  );
  const coverage = verifyEventCoverage();
  assert.equal(coverage.ok, true, coverage.missing?.join(", "));
});
