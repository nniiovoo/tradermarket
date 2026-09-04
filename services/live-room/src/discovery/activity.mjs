// Market Activity: the trust centre (P0).
//
// Every item here is an indexed chain fact. When there is nothing settled, the
// feed is empty and says why — it never fills the space with sample rows,
// invented wins, or plausible-looking volume. A resolution the protocol has not
// reached is simply not shown.

const OUTCOME_LABEL = { 0: "unset", 1: "outcome_a", 2: "outcome_b", 3: "tie", 4: "invalid" };
const SETTLED = new Set(["final", "invalid"]);

function payoutVector(outcome) {
  if (outcome === 1) return { a: "1", b: "0" };
  if (outcome === 2) return { a: "0", b: "1" };
  if (outcome === 3 || outcome === 4) return { a: "0.5", b: "0.5" };
  return null;
}

export class ActivityFeed {
  /**
   * @param options.store      ProjectionStore
   * @param options.settlement optional SettlementService for full records
   */
  constructor({ store, settlement = null }) {
    this.store = store;
    this.settlement = settlement;
  }

  _settledSlots() {
    const slots = [];
    for (const room of this.store.listRooms()) {
      for (const slot of this.store.listSlots(room.room_id)) {
        if (SETTLED.has(slot.state)) slots.push({ room, slot });
      }
    }
    return slots.sort((a, b) => (b.slot.block_number ?? 0) - (a.slot.block_number ?? 0));
  }

  /** Recently settled questions, newest first. */
  recentResolutions(limit = 20) {
    const settled = this._settledSlots();
    if (settled.length === 0) {
      return {
        items: [],
        empty_reason: "No settled market yet. Resolutions appear here once a question closes and resolves on chain.",
      };
    }
    const items = settled.slice(0, limit).map(({ room, slot }) => {
      const market = this.store.getMarket(slot.market_address);
      const outcome = Number(market?.final_outcome ?? 0);
      const participants = {
        a: market?.participant_a_name || null,
        b: market?.participant_b_name || null,
      };
      return {
        room_id: room.room_id,
        slot_index: slot.slot_index,
        market: slot.market_address,
        question: slot.question,
        state: slot.state,
        outcome,
        outcome_label: OUTCOME_LABEL[outcome] ?? "unknown",
        participants,
        winner_name: outcome === 1 ? participants.a : outcome === 2 ? participants.b : null,
        payout_vector: payoutVector(outcome),
        winner_reward_bps: market?.winner_reward_bps ?? slot.winner_reward_bps ?? null,
        closed_seq: slot.closed_seq === undefined || slot.closed_seq === null ? null : String(slot.closed_seq),
        condition_hash: slot.condition_hash ?? null,
        block_number: slot.block_number ?? null,
        route: `/activity/${slot.market_address}`,
      };
    });
    return { items, empty_reason: null };
  }

  /**
   * Real credits, newest first. Each is a claim transaction that happened:
   * a redemption, an LP settlement, fees, a winner reward, or a refund on an
   * invalid market. Nothing is aggregated into a headline "win".
   */
  recentCredits(limit = 20) {
    const claims = [...this.store.listClaims()].sort((a, b) => b.block_number - a.block_number).slice(0, limit);
    if (claims.length === 0) {
      return {
        items: [],
        empty_reason: "No credit has been claimed yet. Payouts appear here after a market settles and someone claims.",
      };
    }
    return {
      items: claims.map((claim) => ({
        market: claim.market_address,
        account: claim.account,
        kind: claim.kind,
        amount: String(claim.amount),
        block_number: claim.block_number,
        route: `/activity/${claim.market_address}`,
      })),
      empty_reason: null,
    };
  }

  /**
   * The opened → closed → final → credited timeline for one market.
   *
   * Each stage reports whether it was actually reached. A stage the protocol
   * has not reached is shown as not reached, never as pending-but-implied.
   */
  timeline(market) {
    const slot = this.store.slotByMarket(market);
    const row = this.store.getMarket(market);
    // Case-insensitive, like every other address comparison here. A claim's
    // address comes from `log.address` (lowercase); a slot's comes from
    // `log.args.market` (checksummed), and the Activity list links with the
    // latter — so a raw `===` reported "not credited" for a market that paid.
    const wanted = String(market).toLowerCase();
    const claims = this.store
      .listClaims()
      .filter((claim) => String(claim.market_address).toLowerCase() === wanted);
    const outcome = Number(row?.final_outcome ?? 0);

    return [
      {
        stage: "opened",
        reached: Boolean(slot?.opens_at),
        at: slot?.opens_at === undefined ? null : String(slot.opens_at ?? ""),
        detail: "The Announce Delay elapsed and the question accepted actions.",
      },
      {
        stage: "closed",
        reached: Boolean(slot && ["closed", "provisional", "challenged", "final", "invalid"].includes(slot.state)),
        at: slot?.closed_seq === undefined || slot?.closed_seq === null ? null : `source sequence ${slot.closed_seq}`,
        detail: "A Decisive Event closed forecasting. Overlapping uncleared actions refund.",
      },
      {
        stage: "final",
        reached: outcome !== 0,
        // A market row's general block is its latest refresh, which may be
        // after claims. Only ResultFinalized proves when finalization happened.
        at: row?.finalized_block_number ? `block ${row.finalized_block_number}` : null,
        detail:
          outcome === 4
            ? "The market could not be resolved and became Invalid. Collateral returns and winner fees refund."
            : "Resolvers reached quorum and the challenge window passed.",
      },
      {
        stage: "credited",
        reached: claims.length > 0,
        at: claims.length > 0 ? `block ${Math.max(...claims.map((claim) => claim.block_number))}` : null,
        detail:
          claims.length > 0
            ? `${claims.length} claim${claims.length === 1 ? "" : "s"} settled on chain.`
            : "Nothing has been claimed yet. Winning positions, LP inventory, fees and refunds are claimable.",
      },
    ];
  }

  /** The full settlement record when a settlement service is wired in. */
  record(market) {
    if (!this.settlement) return null;
    return this.settlement.record(market);
  }
}
