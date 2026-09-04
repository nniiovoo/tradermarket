import { useEffect, useState } from "react";
import { CheckCircle2, Circle, CircleAlert, ExternalLink, Fuel, KeyRound, ShieldCheck } from "lucide-react";
import { useApiResource } from "../hooks/useApiResource.js";
import { Surface } from "./Surface.jsx";
import { termsClaim } from "../chat-claim.js";

const STATE_ICON = {
  done: CheckCircle2,
  required: Circle,
  waiting: Circle,
  blocked: CircleAlert,
  available: Circle,
  not_required: CheckCircle2,
  not_configured: CircleAlert,
};

const STATE_LABEL = {
  done: "Done",
  required: "Do this next",
  waiting: "Waiting on an earlier step",
  blocked: "Blocked",
  available: "Available",
  not_required: "Not required here",
  not_configured: "Not configured",
};

/**
 * The testnet entry journey.
 *
 * Deliberately unglamorous: it states that this is unaudited test software with
 * valueless collateral, asks for each attestation separately, and never claims
 * gas sponsorship or legal approval that does not exist.
 */
export function EntryView({ client, account, onConnect, onSign }) {
  const status = useApiResource(client, `/v1/entry/status${account ? `?address=${account}` : ""}`, {
    deps: [account],
  });
  const terms = useApiResource(client, "/v1/entry/terms");
  const accounts = useApiResource(client, "/v1/account-options");
  const [checked, setChecked] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setChecked({});
    setResult(null);
  }, [account]);

  const attestations = terms.data?.attestations ?? [];
  const allChecked = attestations.length > 0 && attestations.every((item) => checked[item.id]);

  const accept = async () => {
    setSubmitting(true);
    setResult(null);

    // Sign it if the wallet can. The record says this address affirmed
    // statements about their own age, risk and jurisdiction; a signature is
    // what makes it theirs rather than something anyone could post for them.
    // A wallet that cannot sign still proceeds — this is an interface control
    // on valueless testnet software — and the record then says self-declared.
    const claim = termsClaim({ address: account, version: terms.data?.version });
    let signature = null;
    try {
      signature = await onSign?.(claim);
    } catch {
      signature = null;
    }

    const response = await client.post("/v1/entry/accept", {
      address: account,
      version: terms.data?.version,
      attestations: checked,
      ...(signature ? { claim, signature } : {}),
    });
    setSubmitting(false);
    setResult(
      response.ok
        ? { ok: true, proven: response.data?.proven === true, notice: response.data?.notice }
        : { ok: false, message: response.data?.reason ?? response.error }
    );
    if (response.ok) status.reload();
  };

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <ShieldCheck size={15} /> TESTNET ACCESS
        </span>
        <h1>Get started</h1>
        <p>
          TraderMarket runs on a public test network. The collateral is Circle test USDC and has no real-world value,
          the contracts are unaudited, and nothing here is financial advice.
        </p>
        <p className="custody-note">
          This interface never holds your keys and never takes custody of your collateral. Your wallet signs every
          market action directly with the contract, and no order passes through our servers.
        </p>
      </div>

      <Surface resource={status} label="your entry status">
        {(data) => (
          <>
            <ol className="entry-steps">
              {data.steps.map((step) => {
                const Icon = STATE_ICON[step.state] ?? Circle;
                return (
                  <li key={step.id} className={`entry-step ${step.state}`}>
                    <Icon size={20} aria-hidden="true" />
                    <div>
                      <div className="entry-step-head">
                        <strong>{step.title}</strong>
                        <span className="state-chip muted">{STATE_LABEL[step.state] ?? step.state}</span>
                      </div>
                      <p>{step.detail}</p>
                      {step.id === "connect" && !account ? (
                        <button type="button" className="primary-button" onClick={onConnect}>
                          Connect wallet
                        </button>
                      ) : null}
                      {step.id === "funding" && step.url ? (
                        <a className="secondary-button" href={step.url} target="_blank" rel="noreferrer">
                          Open the test-USDC faucet <ExternalLink size={14} aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>

            {accounts.data ? (
              <section className="account-options">
                <div className="section-heading compact">
                  <div>
                    <KeyRound size={18} /> <h2>How you sign in</h2>
                  </div>
                </div>
                <ul className="account-option-list">
                  {accounts.data.options.map((option) => (
                    <li key={option.id} className={option.available ? "available" : "unavailable"}>
                      <div className="entry-step-head">
                        <strong>{option.label}</strong>
                        <span className={`state-chip ${option.available ? "ok" : "muted"}`}>
                          {option.available ? "Available" : "Not available here"}
                        </span>
                      </div>
                      <p>{option.detail}</p>
                      {option.reason ? <p className="muted-note">{option.reason}</p> : null}
                    </li>
                  ))}
                </ul>
                <p className="muted-note">{accounts.data.custody_note}</p>
              </section>
            ) : null}

            <section className="gas-note" role="note">
              <Fuel size={18} aria-hidden="true" />
              <p>{data.gas_statement}</p>
            </section>

            {!data.steps.find((step) => step.id === "terms")?.state.includes("done") && account ? (
              <section className="terms-card">
                <h2>Testnet terms</h2>
                <p className="muted-note">{terms.data?.notice}</p>
                <ul className="attestation-list">
                  {attestations.map((item) => (
                    <li key={item.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(checked[item.id])}
                          onChange={(event) =>
                            setChecked((current) => ({ ...current, [item.id]: event.target.checked }))
                          }
                        />
                        <span>{item.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <button type="button" className="primary-button" disabled={!allChecked || submitting} onClick={accept}>
                  {submitting ? "Recording…" : "Accept and continue"}
                </button>
                {!allChecked ? (
                  <p className="muted-note">Every statement must be affirmed individually.</p>
                ) : null}
                {result && !result.ok ? (
                  <p className="error-note" role="alert">
                    {result.message}
                  </p>
                ) : null}
                {result?.ok && !result.proven ? (
                  <p className="muted-note">{result.notice}</p>
                ) : null}
              </section>
            ) : null}

            <p className="legal-footnote">{data.notice}</p>
          </>
        )}
      </Surface>
    </main>
  );
}
