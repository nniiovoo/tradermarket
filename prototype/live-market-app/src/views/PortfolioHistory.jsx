import { ArrowDownRight, ArrowUpRight, BadgeCheck, Droplets, History, TrendingUp } from "lucide-react";
import { useApiResource } from "../hooks/useApiResource.js";
import { Surface } from "./Surface.jsx";
import { buildPath } from "../router.js";

const USDC = 1_000_000n;

function usdc(value) {
  try {
    const amount = BigInt(value ?? 0);
    const negative = amount < 0n;
    const abs = negative ? -amount : amount;
    return `${negative ? "-" : ""}${abs / USDC}.${String((abs % USDC) / 10_000n).padStart(2, "0")}`;
  } catch {
    return "0.00";
  }
}

const SIDE = { outcome_a: "Outcome A", outcome_b: "Outcome B" };

const OUTCOME = {
  outcome_a: "Outcome A won",
  outcome_b: "Outcome B won",
  tie: "Tie",
  invalid: "Invalid",
  unset: "Not resolved",
};

/**
 * Prediction, transaction, payout and settlement history for one address.
 *
 * Every row is an indexed chain fact. Open positions deliberately carry no
 * payout or profit column: the market has not settled, so any figure there
 * would be a forecast dressed as a receipt.
 */
export function PortfolioHistory({ client, account }) {
  const history = useApiResource(client, `/v1/portfolio/${encodeURIComponent(account ?? "")}`, {
    deps: [account],
    enabled: Boolean(account),
    refreshMs: 30_000,
  });

  if (!account) return null;

  return (
    <Surface resource={history} label="your history">
      {(data) => (
        <div className="history-stack">
          {data.empty_reason ? <p className="muted-note">{data.empty_reason}</p> : null}

          <section className="history-block">
            <div className="section-heading">
              <div>
                <TrendingUp size={18} /> <h2>Predictions</h2>
              </div>
              {data.predictions.claimable_count > 0 ? (
                <span className="state-chip ok">{data.predictions.claimable_count} claimable</span>
              ) : null}
            </div>

            {data.predictions.open.length > 0 ? (
              <>
                <p className="muted-note">{data.predictions.open_note}</p>
                <ul className="history-list">
                  {data.predictions.open.map((row) => (
                    <li key={`${row.market}-${row.side}`}>
                      <a href={`#${row.route}`}>
                        <div>
                          <strong>{row.question || row.market}</strong>
                          <small>
                            {SIDE[row.side] ?? row.side} · open
                          </small>
                        </div>
                        <span className="credit-amount">{usdc(row.size)} positions</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {data.predictions.settled.length > 0 ? (
              <ul className="history-list">
                {data.predictions.settled.map((row) => (
                  <li key={row.market}>
                    <a href={`#${row.route}`}>
                      <div>
                        <strong>{row.question || row.market}</strong>
                        <small>
                          {OUTCOME[row.outcome_label] ?? row.outcome_label} · {row.detail}
                        </small>
                      </div>
                      {/* Three states, not two. `claimable` is null where this
                          build cannot read the per-account balances, and
                          collapsing that into "claimed" tells someone their
                          money is settled when nobody actually looked. */}
                      {row.claimable === true ? (
                        <span className="state-chip ok">
                          {row.owed?.lp_fees > 0n || row.owed?.winner_fee_refund > 0n
                            ? `${usdc(BigInt(row.owed.lp_fees ?? 0) + BigInt(row.owed.winner_fee_refund ?? 0))} claimable`
                            : "Claimable"}
                        </span>
                      ) : row.claimable === null ? (
                        <span className="state-chip muted">Not known</span>
                      ) : (
                        <span className="credit-amount">{usdc(row.claimed)} claimed</span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}

            {data.predictions.open.length === 0 && data.predictions.settled.length === 0 ? (
              <p className="muted-note">No predictions are recorded on chain for this address yet.</p>
            ) : null}
          </section>

          <section className="history-block">
            <div className="section-heading">
              <div>
                <History size={18} /> <h2>Transactions</h2>
              </div>
            </div>
            {data.transactions.length === 0 ? (
              <p className="muted-note">No trades or claims are recorded for this address.</p>
            ) : (
              <ul className="history-list compact">
                {data.transactions.map((row, index) => (
                  <li key={`${row.market}-${row.block_number}-${index}`}>
                    <a href={`#${row.route}`}>
                      <div>
                        <strong>
                          {row.type === "trade" ? (
                            row.kind === "buy" ? (
                              <ArrowUpRight size={14} aria-hidden="true" />
                            ) : (
                              <ArrowDownRight size={14} aria-hidden="true" />
                            )
                          ) : (
                            <BadgeCheck size={14} aria-hidden="true" />
                          )}{" "}
                          {row.summary}
                        </strong>
                        <small>block {row.block_number}</small>
                      </div>
                      <span className="credit-amount">
                        {row.type === "trade" ? `${usdc(row.amount_in)} in` : `${usdc(row.amount)} credited`}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="history-block">
            <div className="section-heading">
              <div>
                <BadgeCheck size={18} /> <h2>Payouts</h2>
              </div>
              <span className="credit-amount">{usdc(data.payouts.total_credited)} test USDC</span>
            </div>
            <p className="muted-note">{data.payouts.note}</p>
            {data.payouts.by_kind.length > 0 ? (
              <ul className="history-list compact">
                {data.payouts.by_kind.map((row) => (
                  <li key={row.kind}>
                    <div>
                      <strong>{row.label}</strong>
                    </div>
                    <span className="credit-amount">{usdc(row.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="history-block">
            <div className="section-heading">
              <div>
                <Droplets size={18} /> <h2>Liquidity</h2>
              </div>
            </div>
            <p className="muted-note">{data.liquidity.note}</p>
            {data.liquidity.positions.length === 0 ? (
              <p className="muted-note">No liquidity positions are recorded for this address.</p>
            ) : (
              <ul className="history-list compact">
                {data.liquidity.positions.map((row) => (
                  <li key={row.market}>
                    <a href={`#${buildPath("activityDetail", { market: row.market }).slice(1)}`}>
                      <div>
                        <strong>{row.question || row.market}</strong>
                        <small>LP shares held</small>
                      </div>
                      <span className="credit-amount">{usdc(row.lp_shares)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Surface>
  );
}
