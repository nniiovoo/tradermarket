import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ExternalLink, Info, RefreshCw, ShieldCheck, Upload, Wallet } from "lucide-react";

const OUTCOME_LABELS = { 1: "Participant A", 2: "Participant B", 3: "Tie", 4: "Invalid / refund" };

function validAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value ?? ""));
}

function localTimestamp(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 19);
}

function proofVideoUrl(client, proof) {
  return proof?.video_url && client?.baseUrl ? `${client.baseUrl}${proof.video_url}` : "";
}

/** Public evidence rendered beside the market, before anyone challenges it. */
export function ResolutionEvidence({ client, market }) {
  const marketAddress = market?.market;
  const [proof, setProof] = useState(null);
  const [challenge, setChallenge] = useState(null);

  useEffect(() => {
    let current = true;
    if (!validAddress(marketAddress) || !client?.configured) {
      setProof(null);
      setChallenge(null);
      return () => { current = false; };
    }
    Promise.all([
      client.get(`/v1/oracle/markets/${marketAddress}`),
      client.get(`/v1/oracle/markets/${marketAddress}/challenge`),
    ]).then(([proofResult, challengeResult]) => {
      if (!current) return;
      setProof(proofResult.ok ? proofResult.data : null);
      setChallenge(challengeResult.ok ? challengeResult.data : null);
    });
    return () => { current = false; };
  }, [client, marketAddress]);

  if (!proof) return null;
  const videoUrl = proofVideoUrl(client, proof);
  return (
    <section className="resolution-evidence" aria-labelledby="resolution-evidence-title">
      <div className="resolution-evidence-copy">
        <span className="eyebrow"><ShieldCheck size={14} /> RESOLUTION EVIDENCE</span>
        <h2 id="resolution-evidence-title">Review the exact proof before settlement</h2>
        <p>{proof.bundle?.rule}</p>
        <dl>
          <div><dt>Proposed result</dt><dd>{OUTCOME_LABELS[proof.outcome] ?? `Outcome ${proof.outcome}`}</dd></div>
          <div><dt>Source sequence</dt><dd>{proof.bundle?.source_sequence}</dd></div>
          <div><dt>Event time</dt><dd>{new Date(proof.bundle?.occurred_at).toLocaleString()}</dd></div>
          <div><dt>Clip window</dt><dd>{Number(proof.bundle?.clip_start_ms) / 1000}s–{Number(proof.bundle?.clip_end_ms) / 1000}s</dd></div>
          <div><dt>Evidence hash</dt><dd><code>{proof.evidence_hash}</code></dd></div>
        </dl>
        {challenge ? <div className="evidence-hash"><span>Verified audience counter-evidence</span>{/^https:\/\//i.test(challenge.evidence) ? <a href={challenge.evidence} target="_blank" rel="noreferrer">Open counter-evidence <ExternalLink size={13} /></a> : <code>{challenge.evidence}</code>}<small><Check size={13} /> Linked to confirmed bonded challenge {challenge.transaction_hash.slice(0, 10)}…</small></div> : null}
        <p className="muted-note">This upload is evidence, not a result. Two distinct resolver wallets must attest this same hash on chain, then the audience challenge window opens.</p>
      </div>
      {videoUrl ? <video className="evidence-video" controls preload="metadata" src={videoUrl} /> : null}
    </section>
  );
}

/** Operator console. The browser wallet — never the API — signs result actions. */
export function OracleView({ client, testnet, market, onConnect, onNotify }) {
  const marketAddress = market?.market ?? testnet.snapshot?.marketAddress ?? testnet.marketAddress ?? "";
  const [resolution, setResolution] = useState(null);
  const [proof, setProof] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [operatorToken, setOperatorToken] = useState("");
  const [outcome, setOutcome] = useState(1);
  const [streamUrl, setStreamUrl] = useState(market?.streamUrl ?? "");
  const [occurredAt, setOccurredAt] = useState(() => localTimestamp());
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(30);
  const [rule, setRule] = useState(market?.question ?? "");
  const [rationale, setRationale] = useState("");
  const [sourceSequence, setSourceSequence] = useState("");
  const [clip, setClip] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [transactionUrl, setTransactionUrl] = useState("");

  const outcomeLabels = useMemo(() => ({
    1: resolution?.participantAName || market?.participants?.[0] || "Participant A",
    2: resolution?.participantBName || market?.participants?.[1] || "Participant B",
    3: "Tie",
    4: "Invalid / refund",
  }), [market?.participants, resolution]);

  const refresh = async () => {
    if (!validAddress(marketAddress)) return;
    setBusy("refresh");
    setError("");
    try {
      const [chain, archived, counterEvidence] = await Promise.all([
        testnet.readResolution({ marketAddress }),
        client.get(`/v1/oracle/markets/${marketAddress}`),
        client.get(`/v1/oracle/markets/${marketAddress}/challenge`),
      ]);
      setResolution(chain);
      setProof(archived.ok ? archived.data : null);
      setChallenge(counterEvidence.ok ? counterEvidence.data : null);
      if (chain?.streamUrl) setStreamUrl(chain.streamUrl);
      if (chain?.question) setRule((current) => current || chain.question);
      setSourceSequence((current) => current || String(BigInt(chain?.lastSafeSequence ?? 0n) + 1n));
    } catch (cause) {
      setError(cause?.shortMessage || cause?.message || "The resolution state could not be read.");
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    refresh();
    // Changing wallets changes resolver authorization even if the market stays.
  }, [marketAddress, testnet.account]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (event) => {
    event.preventDefault();
    if (!clip) {
      setError("Choose the exact MP4 proof clip.");
      return;
    }
    setBusy("upload");
    setError("");
    try {
      const result = await client.uploadLivestreamProof({
        market: marketAddress,
        outcome,
        sourceSequence,
        streamUrl,
        occurredAt: new Date(occurredAt).toISOString(),
        clipStartMs: Math.round(Number(clipStart) * 1000),
        clipEndMs: Math.round(Number(clipEnd) * 1000),
        rule,
        rationale,
      }, clip, operatorToken);
      if (!result.ok) throw new Error(result.error);
      setProof(result.data);
      onNotify?.("Evidence archived. It is not a result until a second independent resolver reaches quorum.");
    } catch (cause) {
      setError(cause?.message || "The proof could not be archived.");
    } finally {
      setBusy("");
    }
  };

  const runAction = async (action, payload = {}) => {
    setBusy(action);
    setError("");
    try {
      const signer = testnet.account || await onConnect();
      if (!signer) throw new Error("Connect a wallet before submitting the resolution action.");
      const result = await testnet.resolve(action, payload, { marketAddress, account: signer });
      setTransactionUrl(result.url);
      onNotify?.("Resolution transaction confirmed on chain.");
      await refresh();
    } catch (cause) {
      setError(cause?.shortMessage || cause?.message || "The resolution action could not be submitted.");
    } finally {
      setBusy("");
    }
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const challengeEnds = Number(resolution?.provisionalAt ?? 0n) + Number(resolution?.challengeWindow ?? 0n);
  const challengeExpires = Number(resolution?.challengedAt ?? 0n) + Number(resolution?.challengeTimeout ?? 0n);
  const resolutionDue = Number(resolution?.resolutionDueAt ?? 0n);
  const archivedVideo = proofVideoUrl(client, proof);
  const proofMatchesChain = Boolean(proof?.evidence_hash && resolution?.provisionalEvidenceHash
    && proof.evidence_hash.toLowerCase() === resolution.provisionalEvidenceHash.toLowerCase());

  if (!validAddress(marketAddress)) {
    return <main className="page secondary-view oracle-view"><div className="view-title"><span className="eyebrow">RESOLVER CONSOLE</span><h1>No market is selected</h1><p>Open a deployed livestream market before preparing evidence.</p></div></main>;
  }

  return (
    <main className="page secondary-view oracle-view">
      <div className="view-title">
        <span className="eyebrow"><ShieldCheck size={15} /> EVIDENCE-BACKED RESOLUTION</span>
        <h1>Prepare proof, then attest from independent wallets</h1>
        <p>The API archives evidence only. It has no chain key and cannot decide the winner. Two frozen resolver wallets must independently inspect and attest the same hash.</p>
      </div>

      <section className="oracle-status-card">
        <div><span>Market</span><code>{marketAddress}</code></div>
        <div><span>Chain state</span><strong>{!resolution ? "Not read — actions locked" : resolution.finalOutcome ? `Final · ${outcomeLabels[resolution.finalOutcome]}` : resolution.challenged ? "Challenged" : resolution.provisionalOutcome ? "Provisional" : "Awaiting attestations"}</strong></div>
        <div><span>Connected wallet</span><strong>{testnet.account ? resolution?.isResolver ? "Authorized resolver" : resolution?.isGate ? "Gate Authority" : "Viewer / permissionless finalizer" : "Not connected"}</strong></div>
        <button className="secondary-button" onClick={refresh} disabled={busy === "refresh"}><RefreshCw size={15} /> Refresh</button>
      </section>

      <div className="oracle-grid">
        <form className="oracle-card" onSubmit={upload}>
          <span className="sheet-kicker">1 · ARCHIVE CANONICAL EVIDENCE</span>
          <h2>Upload the complete observation recording</h2>
          <label className="creator-field"><span>Operator token</span><input type="password" value={operatorToken} onChange={(event) => setOperatorToken(event.target.value)} autoComplete="off" /></label>
          <label className="creator-field"><span>Proposed outcome</span><select value={outcome} onChange={(event) => setOutcome(Number(event.target.value))}>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="creator-field"><span>Evidence event sequence</span><input type="number" min="1" step="1" value={sourceSequence} onChange={(event) => setSourceSequence(event.target.value)} /><small>The same immutable sequence is used by the Gate Authority to close forecasting.</small></label>
          <label className="creator-field"><span>Official stream page</span><input type="url" value={streamUrl} onChange={(event) => setStreamUrl(event.target.value)} /></label>
          <label className="creator-field"><span>Event time</span><input type="datetime-local" step="1" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
          <div className="creator-pair">
            <label className="creator-field"><span>Review window starts (seconds)</span><input type="number" min="0" step="0.1" value={clipStart} onChange={(event) => setClipStart(event.target.value)} /></label>
            <label className="creator-field"><span>Review window ends (seconds)</span><input type="number" min="0.1" step="0.1" value={clipEnd} onChange={(event) => setClipEnd(event.target.value)} /></label>
          </div>
          <label className="creator-field"><span>Frozen winning rule</span><textarea rows="3" value={rule} onChange={(event) => setRule(event.target.value)} /></label>
          <label className="creator-field"><span>Resolver rationale</span><textarea rows="4" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Name the first qualifying frame and why the other outcome had not already occurred." /></label>
          <label className="creator-field"><span>Complete MP4 Observation Window · maximum 250 MiB</span><input type="file" accept="video/mp4,.mp4" onChange={(event) => setClip(event.target.files?.[0] ?? null)} /></label>
          <p className="muted-note">The focused review window may be at most 120 seconds, but the uploaded MP4 must include everything from the frozen opening watermark through the claimed event.</p>
          <button className="primary-button full" type="submit" disabled={!resolution || !operatorToken || !clip || !sourceSequence || !rule.trim() || !rationale.trim() || busy === "upload"}><Upload size={16} /> {busy === "upload" ? "Archiving recording…" : "Archive recording and calculate hash"}</button>
          {!resolution ? <p className="source-note"><Info size={16} /><span>Evidence actions stay locked until this exact market contract can be read.</span></p> : null}
        </form>

        <section className="oracle-card">
          <span className="sheet-kicker">2 · INDEPENDENT ON-CHAIN REVIEW</span>
          <h2>Attest or handle the challenge</h2>
          {proof ? <>{archivedVideo ? <video className="evidence-video" controls preload="metadata" src={archivedVideo} /> : null}<div className="evidence-hash"><span>Canonical evidence hash</span><code>{proof.evidence_hash}</code>{proofMatchesChain ? <small><Check size={13} /> Matches the provisional result on chain</small> : null}</div><p>{proof.bundle?.rationale}</p></> : <p className="muted-note">No archived proof exists for this market yet.</p>}

          {!testnet.account ? <button className="secondary-button full" onClick={onConnect}><Wallet size={16} /> Connect resolver wallet</button> : null}
          {proof && resolution?.isGate && resolution?.gateState !== 2 && !resolution?.finalOutcome ? <div className="gate-close-box"><span className="muted-note">Evidence event sequence <strong>{proof.bundle?.source_sequence}</strong></span><button className="danger-button full" disabled={Boolean(busy)} onClick={() => runAction("closeForDecisiveEvent", { sourceSequence: proof.bundle?.source_sequence })}>Irreversibly close forecasting for this event</button><small>Use the isolated Gate Authority wallet. This exact sequence is committed inside the evidence hash. Closing refunds unsafe overlapping actions; it does not select the winner.</small></div> : null}
          {proof && resolution?.isResolver && !resolution?.provisionalOutcome && !resolution?.finalOutcome ? <button className="primary-button full" disabled={Boolean(busy)} onClick={() => runAction("attestResult", { outcome: proof.outcome, evidenceHash: proof.evidence_hash })}>Attest this exact outcome and hash <ArrowRight size={16} /></button> : null}
          {proof && testnet.account && !resolution?.isResolver && !resolution?.finalOutcome ? <div className="source-note"><Info size={16} /><span>This wallet is not one of the market’s three frozen resolvers. It cannot attest, but it may use permissionless finalization after a deadline.</span></div> : null}

          {resolution?.challenged && !resolution?.finalOutcome && resolution?.isResolver ? <div className="oracle-actions"><button className="danger-button" disabled={Boolean(busy)} onClick={() => runAction("attestChallengeVerdict", { acceptChallenge: true })}>Accept challenge → Invalid and refund bond</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => runAction("attestChallengeVerdict", { acceptChallenge: false })}>Reject challenge → keep provisional result</button></div> : null}
          {resolution?.challenged ? challenge ? <div className="evidence-hash"><span>Verified bonded counter-evidence</span>{/^https:\/\//i.test(challenge.evidence) ? <a href={challenge.evidence} target="_blank" rel="noreferrer">Open counter-evidence <ExternalLink size={13} /></a> : <code>{challenge.evidence}</code>}<small><Check size={13} /> Registered from confirmed transaction {challenge.transaction_hash.slice(0, 10)}…</small></div> : <div className="inline-error" role="alert"><Info size={16} /><span>The chain contains a challenge hash, but its review reference is not registered. Do not adjudicate until the challenger’s confirmed reference is recovered.</span></div> : null}
          {resolution?.provisionalOutcome && !resolution?.challenged && !resolution?.finalOutcome ? <button className="secondary-button full" disabled={Boolean(busy) || nowSeconds < challengeEnds} onClick={() => runAction("finalizeUnchallenged")}>Finalize after challenge window{nowSeconds < challengeEnds ? ` · opens ${new Date(challengeEnds * 1000).toLocaleTimeString()}` : ""}</button> : null}
          {resolution?.challenged && !resolution?.finalOutcome ? <button className="secondary-button full" disabled={Boolean(busy) || nowSeconds < challengeExpires} onClick={() => runAction("expireChallenge")}>Expire unanswered challenge → Invalid + return bond</button> : null}
          {resolution?.gateState === 2 && !resolution?.provisionalOutcome && !resolution?.finalOutcome ? <button className="secondary-button full" disabled={Boolean(busy) || nowSeconds < resolutionDue} onClick={() => runAction("invalidateUnresolved")}>Invalidate after missing resolver deadline</button> : null}

          <div className="risk-note"><ShieldCheck size={16} /><span>A second resolver must use a different frozen wallet. Repeating this action from the same address is rejected by the contract.</span></div>
          {transactionUrl ? <a className="transaction-link" href={transactionUrl} target="_blank" rel="noreferrer">View confirmed transaction <ExternalLink size={14} /></a> : null}
        </section>
      </div>
      {error ? <div className="inline-error oracle-error" role="alert"><Info size={16} /><span>{error}</span></div> : null}
    </main>
  );
}
