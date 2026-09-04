import { useMemo } from "react";
import { ArrowRight, BadgeCheck, CircleSlash, Clock, FileSearch, Layers, Scale } from "lucide-react";
import { useApiResource } from "../hooks/useApiResource.js";
import { Surface } from "./Surface.jsx";
import { buildPath } from "../router.js";
import { formatTimelineMoment, honestTimeline, settlementResultLabel } from "./activity-format.js";

const USDC = 1_000_000n;

function usdc(value) {
  try {
    const amount = BigInt(value ?? 0);
    const whole = amount / USDC;
    const cents = (amount % USDC) / 10_000n;
    return `${whole}.${String(cents).padStart(2, "0")}`;
  } catch {
    return "0.00";
  }
}

const OUTCOME_COPY = {
  outcome_a: { label: "Outcome A", tone: "ok" },
  outcome_b: { label: "Outcome B", tone: "ok" },
  tie: { label: "Tie — both sides redeem at 0.5", tone: "warn" },
  invalid: { label: "Invalid — collateral returned", tone: "warn" },
  unset: { label: "Not resolved", tone: "muted" },
};

const CLAIM_COPY = {
  redeem: "Winning position redeemed",
  lp_inventory: "LP inventory settled",
  lp_fees: "LP fees claimed",
  winner_reward: "Winning-participant reward",
  winner_fee_refund: "Winner-fee refund (invalid market)",
};

/** The Market Activity index: what settled, and what was actually credited. */
export function ActivityView({ client }) {
  const activity = useApiResource(client, "/v1/activity", { refreshMs: 20_000 });

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <FileSearch size={15} /> SETTLEMENT RECORD
        </span>
        <h1>Market Activity</h1>
        <p>
          Every resolution and every credit below is an indexed chain fact. Open one to see the source events that
          decided it, who attested, and the transactions that paid it out.
        </p>
      </div>

      <Surface
        resource={activity}
        label="market activity"
        emptyWhen={(data) => data.resolutions.items.length === 0 && data.credits.items.length === 0}
        empty={
          <div>
            <strong>Nothing has settled yet</strong>
            <p>{activity.data?.resolutions?.empty_reason}</p>
          </div>
        }
      >
        {(data) => (
          <div className="activity-grid">
            <section className="activity-column">
              <div className="section-heading">
                <div>
                  <Layers size={18} /> <h2>Recent resolutions</h2>
                </div>
              </div>
              {data.resolutions.items.length === 0 ? (
                <p className="muted-note">{data.resolutions.empty_reason}</p>
              ) : (
                <ul className="resolution-list">
                  {data.resolutions.items.map((item) => {
                    const outcome = OUTCOME_COPY[item.outcome_label] ?? OUTCOME_COPY.unset;
                    const resultLabel = settlementResultLabel(item, item.participants);
                    return (
                      <li key={item.market}>
                        <a href={buildPath("activityDetail", { market: item.market })} className="resolution-row">
                          <span className={`state-chip ${outcome.tone}`}>{resultLabel}</span>
                          <span className="resolution-question">{item.question || "Untitled question"}</span>
                          <span className="resolution-meta">
                            {/* The market's own rate. It is per-market and zero
                                is a valid setting — half the questions in a
                                typical room charge nothing. */}
                            {item.winner_reward_bps === null || item.winner_reward_bps === undefined
                              ? "participant reward not read"
                              : `${Number(item.winner_reward_bps) / 100}% participant reward`}
                            {item.closed_seq ? ` · closed at source seq ${item.closed_seq}` : ""}
                          </span>
                          <ArrowRight size={15} aria-hidden="true" />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="activity-column">
              <div className="section-heading">
                <div>
                  <BadgeCheck size={18} /> <h2>Recent credits</h2>
                </div>
              </div>
              {data.credits.items.length === 0 ? (
                <p className="muted-note">{data.credits.empty_reason}</p>
              ) : (
                <ul className="credit-list">
                  {data.credits.items.map((item, index) => (
                    <li key={`${item.market}-${item.account}-${index}`}>
                      <div>
                        <strong>{CLAIM_COPY[item.kind] ?? item.kind}</strong>
                        <small>
                          <a href={buildPath("profile", { address: item.account })}>{item.account}</a> · block{" "}
                          {item.block_number}
                        </small>
                      </div>
                      <span className="credit-amount">{usdc(item.amount)} test USDC</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Surface>
    </main>
  );
}

/** One settled market: the trust centre for a single question. */
export function ActivityDetailView({ client, market }) {
  const detail = useApiResource(client, `/v1/activity/${encodeURIComponent(market)}`);
  const settlement = detail.data?.settlement ?? null;

  const stages = useMemo(
    () => honestTimeline(detail.data?.timeline ?? [], detail.data?.claims ?? []),
    [detail.data]
  );

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <Scale size={15} /> SETTLEMENT REPLAY
        </span>
        <h1>Settlement record</h1>
        <p>
          The frozen question, the source facts that decided it, the resolvers who independently reconstructed it, and
          every payout — each traceable to chain.
        </p>
        <a className="inline-link" href={buildPath("activity")}>
          ← All market activity
        </a>
      </div>

      <Surface resource={detail} label="this settlement">
        {(data) => (
          <>
            {settlement ? (
              <section className="settlement-card">
                <h2>{settlement.question ?? "Question"}</h2>
                <dl className="settlement-facts">
                  <div>
                    <dt>Result</dt>
                    <dd>{settlementResultLabel(settlement.resolution, settlement.participants)}</dd>
                  </div>
                  <div>
                    <dt>Payout vector</dt>
                    <dd>
                      {settlement.resolution?.payout_vector
                        ? `A ${settlement.resolution.payout_vector.a} · B ${settlement.resolution.payout_vector.b}`
                        : "not resolved"}
                    </dd>
                  </div>
                  <div>
                    <dt>Resolver quorum</dt>
                    <dd>{settlement.resolution?.quorum ? "reached (2 of 3)" : "not reached"}</dd>
                  </div>
                  <div>
                    <dt>Evaluator</dt>
                    <dd>{settlement.evaluator_version ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Condition hash</dt>
                    <dd className="mono">{settlement.condition_hash ?? "—"}</dd>
                  </div>
                </dl>

                {settlement.invalidation ? (
                  <div className="invalid-explainer" role="note">
                    <CircleSlash size={18} aria-hidden="true" />
                    <div>
                      <strong>Why this market is Invalid</strong>
                      <p>{settlement.invalidation.explanation}</p>
                      <p className="muted-note">
                        Positions redeem at half each, and any winning-participant reward you paid is refunded
                        separately at whatever rate this market charged. A missing result never becomes a default win.
                      </p>
                      {/* The one thing an Invalid refund does not return. Saying it
                          here is the difference between a rule and a surprise: a
                          refunded forecaster who reconciles their own balance would
                          otherwise find the gap themselves and have nothing to read. */}
                      <p className="muted-note">
                        The 0.3% liquidity fee you paid when you traded is not refunded. It went to the liquidity
                        providers who took the other side and carried the inventory while this market was open,
                        which they did whether or not it produced a result.
                      </p>
                    </div>
                  </div>
                ) : null}

                {settlement.deciding_events?.length ? (
                  <div className="evidence-block">
                    <h3>Source evidence</h3>
                    <p className="muted-note">
                      These are the approved-source facts the result was reconstructed from. The livestream is context
                      only and never decides a result.
                    </p>
                    <ul className="evidence-list">
                      {settlement.deciding_events.map((event) => (
                        <li key={event.seq}>
                          <span className="mono">#{event.seq}</span>
                          <span>
                            {event.kind}
                            {event.participant ? ` · ${event.participant}` : ""}
                          </span>
                          <span className="muted-note">{event.observed_at}</span>
                          {/* A restated fact is shown at what the provider now
                              says, and said to be a restatement. Showing the
                              corrected figure silently would read as though the
                              source never changed its mind. */}
                          {event.corrected ? <span className="state-chip muted">restated by the source</span> : null}
                          {event.stream_offset_s !== null && event.stream_offset_s !== undefined ? (
                            <span className="muted-note">stream +{event.stream_offset_s}s</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : (
              <p className="muted-note">
                A full settlement record is not available for this market. The timeline below still reflects chain
                state.
              </p>
            )}

            <section className="timeline-card">
              <div className="section-heading">
                <div>
                  <Clock size={18} /> <h2>Timeline</h2>
                </div>
              </div>
              <ol className="timeline">
                {stages.map((stage) => (
                  <li key={stage.stage} className={stage.reached ? "reached" : "pending"}>
                    <span className="timeline-dot" aria-hidden="true" />
                    <div>
                      <strong>{stage.stage}</strong>
                      <small>
                        {formatTimelineMoment(stage.stage, stage.at) ??
                          (stage.reached ? "time unknown" : "not reached yet")}
                      </small>
                      <p>{stage.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="claims-card">
              <div className="section-heading">
                <div>
                  <BadgeCheck size={18} /> <h2>Payouts and refunds</h2>
                </div>
              </div>
              {data.claims?.length ? (
                <ul className="credit-list">
                  {data.claims.map((claim, index) => (
                    <li key={`${claim.account}-${index}`}>
                      <div>
                        <strong>{CLAIM_COPY[claim.kind] ?? claim.kind}</strong>
                        <small>
                          <a href={buildPath("profile", { address: claim.account })}>{claim.account}</a> · block{" "}
                          {claim.block_number}
                        </small>
                      </div>
                      <span className="credit-amount">{usdc(claim.amount)} test USDC</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-note">
                  Nothing has been claimed on this market yet. Winning positions, LP inventory, LP fees, the
                  winning-participant reward and invalid-market refunds are each claimed separately by their owner.
                </p>
              )}
            </section>

            {data.attestations?.length ? (
              <section className="claims-card">
                <div className="section-heading">
                  <div>
                    <BadgeCheck size={18} /> <h2>Resolver attestations</h2>
                  </div>
                </div>
                <ul className="credit-list">
                  {data.attestations.map((entry, index) => (
                    <li key={`${entry.resolver}-${index}`}>
                      <div>
                        <strong className="mono">{entry.resolver}</strong>
                        <small>
                          outcome {entry.outcome} · attestation {entry.count} of 2 · block {entry.block_number}
                        </small>
                      </div>
                      <span className="mono muted-note">{String(entry.evidence_hash).slice(0, 14)}…</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </Surface>
    </main>
  );
}
