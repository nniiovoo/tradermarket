import { Copy, Sparkles, Trophy, Users } from "lucide-react";
import { useState } from "react";
import { useApiResource } from "../hooks/useApiResource.js";
import { Surface } from "./Surface.jsx";

const USDC = 1_000_000n;
const usdc = (value) => {
  try {
    const amount = BigInt(value ?? 0);
    return `${amount / USDC}.${String((amount % USDC) / 10_000n).padStart(2, "0")}`;
  } catch {
    return "0.00";
  }
};

/**
 * Referrals, shown honestly.
 *
 * Where no programme is configured this page says so and offers nothing. Where
 * one is, it shows the code and the count that is actually attributable — which
 * starts at zero — and never a reward figure the deployment has not funded.
 */
export function ReferralsView({ client, account, onConnect }) {
  const referrals = useApiResource(client, `/v1/referrals/${encodeURIComponent(account ?? "")}`, {
    deps: [account],
    enabled: Boolean(account),
  });
  const community = useApiResource(client, "/v1/community");
  const [copied, setCopied] = useState(false);

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <Sparkles size={15} /> COMMUNITY
        </span>
        <h1>Refer a forecaster</h1>
        <p>
          Invite someone to a public test network. Nothing here has real-world value, and a referral only counts once
          it is linked to a real on-chain action.
        </p>
      </div>

      {!account ? (
        <div className="empty-card">
          <Users size={30} />
          <h2>Connect your wallet</h2>
          <p>A referral code is derived from your address, so there is nothing to show until one is connected.</p>
          <button type="button" className="primary-button" onClick={onConnect}>
            Connect wallet
          </button>
        </div>
      ) : (
        <Surface resource={referrals} label="your referral status">
          {(data) =>
            !data.available ? (
              <div className="surface-state muted">
                <div>
                  <strong>No referral programme is running here</strong>
                  <p>{data.reason}</p>
                </div>
              </div>
            ) : (
              <section className="referral-card">
                <div className="referral-code">
                  <span>Your code</span>
                  <strong className="mono">{data.code}</strong>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      navigator.clipboard?.writeText(data.code);
                      setCopied(true);
                    }}
                  >
                    <Copy size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <dl className="settlement-facts">
                  <div>
                    <dt>Attributed referrals</dt>
                    <dd>{data.referred}</dd>
                  </div>
                  <div>
                    <dt>Credited</dt>
                    <dd>{usdc(data.earned)} test USDC</dd>
                  </div>
                  <div>
                    <dt>Programme</dt>
                    <dd className="mono">{data.program_id}</dd>
                  </div>
                </dl>
                <p className="muted-note">{data.attribution_note}</p>
                <p className="legal-footnote">{data.notice}</p>
              </section>
            )
          }
        </Surface>
      )}

      {community.data?.available ? (
        <section className="referral-card">
          <h2>Community</h2>
          <p className="muted-note">{community.data.notice}</p>
          <ul className="help-results">
            {community.data.links.map((link) => (
              <li key={link.id}>
                <a href={link.url} target="_blank" rel="noreferrer">
                  <strong>{link.label}</strong>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

/**
 * Recent real wins.
 *
 * Renders nothing at all where social proof is not configured or where nobody
 * has been credited: an empty strip is better than a manufactured one.
 */
export function SocialProof({ client }) {
  const proof = useApiResource(client, "/v1/social-proof", { refreshMs: 30_000 });
  const data = proof.data;
  if (!data?.available || data.recent_wins.length === 0) return null;

  return (
    <section className="social-proof">
      <div className="section-heading compact">
        <div>
          <Trophy size={18} /> <h2>Recently credited</h2>
        </div>
        <span className="muted-note">{data.basis}</span>
      </div>
      <ul className="history-list compact">
        {data.recent_wins.map((win) => (
          <li key={`${win.market}-${win.account}-${win.block_number}`}>
            <a href={`#${win.route}`}>
              <div>
                <strong className="mono">
                  {win.account.slice(0, 8)}…
                </strong>
                <small>{win.question || win.market}</small>
              </div>
              <span className="credit-amount positive">{usdc(win.amount)} test USDC</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
