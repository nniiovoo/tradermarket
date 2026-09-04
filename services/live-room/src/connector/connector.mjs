// Source Connector core: archives raw provider bytes, deduplicates, chains,
// signs, and appends normalized events. Security-critical (ADR 0024): a
// compromised connector can close a market early or force invalidation, so
// everything it writes is replayable and independently reconstructible.
//
// The connector's signing key is SEPARATE from the gate key.

import { keccak256, toHex, recoverMessageAddress } from "viem";
import { buildEvent, contentKey, dedupeKey, canonicalize } from "../domain/eventlog.mjs";

export class SourceConnector {
  /**
   * @param options.roomId       room identifier
   * @param options.source       source name (e.g. "hyperliquid-testnet")
   * @param options.store        EventStore port
   * @param options.rawArchive   RawArchive port
   * @param options.signer       viem local account (connector key, NOT the gate key)
   * @param options.clock        () => ISO timestamp (injected for determinism)
   */
  constructor({ roomId, source, store, rawArchive, signer, clock }) {
    this.roomId = roomId;
    this.source = source;
    this.store = store;
    this.rawArchive = rawArchive;
    this.signer = signer;
    this.clock = clock ?? (() => new Date().toISOString());
    // Two indexes, because two different questions are being asked. `seen` is
    // "have I recorded this exact content" — the answer for a retry or a window
    // overlap. `latest` is "what did I last record under this fact id" — the
    // answer for a restatement, which must be appended as a correction rather
    // than dropped as a duplicate.
    //
    // Empty here, not populated: the store's port is async and a constructor
    // cannot await it (same reason GateAuthority loads lazily). ingestBatch()
    // ensures it is loaded before touching `latest`.
    this.latest = new Map();
    this._loaded = false;
  }

  /**
   * Restores the dedup index from the durable log explicitly.
   *
   * Public for the same reason GateAuthority.load() is: a caller may want to
   * know the connector has resumed before feeding it its first batch, rather
   * than discovering it lazily on the first ingest.
   */
  async load() {
    return this._ensureLoaded();
  }

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    for (const event of await this.store.all()) this.latest.set(dedupeKey(event), event);
  }

  /**
   * Ingests one provider batch: the exact raw response bytes, the CLOSED query
   * window that produced them, and the normalized drafts derived from them.
   * Appends only unseen facts; returns the appended events.
   */
  async ingestBatch({ rawBytes, rawQuery, drafts }) {
    await this._ensureLoaded();
    if (!rawQuery || rawQuery.open_ended) {
      throw new Error("raw_query must describe a closed window");
    }
    const rawHash = keccak256(toHex(rawBytes));
    // The archive id must be unique per QUERY, not per content: two accounts
    // can legitimately return byte-identical responses (e.g. equal baselines),
    // and a content-only id would collide and silently drop the second.
    const queryHash = keccak256(toHex(canonicalize(rawQuery)));
    const rawRef = await this.rawArchive.put(
      `${this.roomId}-${queryHash.slice(2, 18)}-${rawHash.slice(2, 10)}`,
      rawBytes
    );
    const appended = [];
    for (const draft of drafts) {
      const identified = { ...draft, source: this.source };
      const superseded = this.latest.get(dedupeKey(identified)) ?? null;

      // News is measured against what this fact CURRENTLY says, not against
      // everything it has ever said. The same content in the same state is a
      // retry or a window overlap and adds nothing. Anything else — including a
      // provider restating a fact back to a figure it reported earlier, which a
      // lagging read replica does routinely — is the provider changing its mind,
      // and the log follows the provider.
      //
      // Remembering every value forever instead meant such a re-report was
      // dropped from the log while its payload still entered the raw archive.
      // The log then said one thing and the bytes a resolver rebuilds from said
      // another, and every resolver refused to attest — for every slot in the
      // room — so every market finalized Invalid over a read the connector had
      // quietly swallowed.
      if (superseded && contentKey(superseded) === contentKey(identified)) continue;

      const event = buildEvent({
        tip: await this.store.tip(),
        draft: {
          ...draft,
          room_id: this.roomId,
          source: this.source,
          raw_ref: rawRef,
          raw_hash: rawHash,
          raw_query: rawQuery,
          corrects: superseded ? superseded.hash : null,
        },
        ingestedAt: this.clock(),
      });
      event.connector_signature = await this.signer.signMessage({ message: { raw: event.hash } });
      await this.store.append(event);
      this.latest.set(dedupeKey(identified), event);
      appended.push(event);
    }
    return appended;
  }

  /** Appends a heartbeat so silence is distinguishable from staleness. */
  async heartbeat(observedAt) {
    const observed = observedAt ?? this.clock();
    return this.ingestBatch({
      rawBytes: JSON.stringify({ heartbeat: observed }),
      rawQuery: { kind: "heartbeat", at: observed },
      drafts: [
        {
          source_event_id: `heartbeat-${observed}`,
          participant: null,
          observed_at: observed,
          kind: "heartbeat",
          facts: {},
        },
      ],
    });
  }
}

/** Signature verifier for verifyChain: recovers the connector address. */
export function makeSignatureVerifier(connectorAddress) {
  return async (event) => {
    if (!event.connector_signature) return false;
    try {
      const recovered = await recoverMessageAddress({
        message: { raw: event.hash },
        signature: event.connector_signature,
      });
      return recovered.toLowerCase() === connectorAddress.toLowerCase();
    } catch {
      return false;
    }
  };
}
