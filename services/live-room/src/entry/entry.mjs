// The testnet entry journey (P0).
//
// Four steps, in order, each with an honest state: connect an account, accept
// terms, pass the interface allowlist if one is enabled, and fund with test
// USDC. The gate is explicit that it is an interface control on unaudited
// testnet software whose collateral has no real-world value, and it never
// implies that anything here has legal approval.
//
// Acceptance is bound to a terms VERSION. Changing the terms re-prompts rather
// than silently inheriting a consent given to different words.

export const TERMS_VERSION = "testnet-1";

export const ELIGIBILITY_ATTESTATIONS = [
  {
    id: "age",
    label: "I am at least 18 years old.",
  },
  {
    id: "testnet",
    label:
      "I understand this is unaudited test software, that the collateral is Circle test USDC with no real-world value, and that nothing here is an investment.",
  },
  {
    id: "risk",
    label:
      "I understand prediction positions can lose their full value, that liquidity providers bear inventory risk, and that a market can resolve Invalid and return collateral instead of paying out.",
  },
  {
    id: "no_advice",
    label: "I understand TraderMarket gives no financial, investment, or trading advice.",
  },
  {
    id: "jurisdiction",
    label:
      "I am not a citizen, resident of, or located in a sanctioned jurisdiction, and I am responsible for my own compliance with local law.",
  },
];

const LEGAL_NOTICE =
  "This is an interface control on unaudited testnet software. It restricts who uses this interface, " +
  "not who can transact with a deployed contract. Collateral is Circle test USDC on a public test network " +
  "and has no real-world value. TraderMarket makes no claim of legal availability in any jurisdiction and " +
  "legal review is not complete.";

export class EntryGate {
  /**
   * @param options.allowlist    Allowlist instance (may be disabled)
   * @param options.capabilities Capabilities instance
   * @param options.acceptances  optional Map address -> version
   */
  constructor({ allowlist, capabilities, acceptances = new Map(), verifySignature = null }) {
    this.allowlist = allowlist;
    this.capabilities = capabilities;
    this.acceptances = acceptances;
    this.verify = verifySignature;
    // Whether each acceptance came with a signature that verified.
    // Map-backed deployments keep this here. Durable stores expose proven() /
    // setProven(), and those methods must be the source after a restart.
    this.proven = new Map();
  }

  async _isProven(address) {
    const key = String(address ?? "").toLowerCase();
    if (typeof this.acceptances?.proven === "function") return this.acceptances.proven(key);
    return Boolean(this.proven.get(key));
  }

  async _rememberProof(address, proven) {
    const key = String(address).toLowerCase();
    const next = Boolean(proven || (await this._isProven(key)));
    if (typeof this.acceptances?.setProven === "function") await this.acceptances.setProven(key, next);
    else this.proven.set(key, next);
    return next;
  }

  /**
   * The string a terms acceptance is signed over.
   *
   * The record says a specific address affirmed statements about their own age,
   * risk understanding and jurisdiction. Anyone can post any address, so without
   * a signature the record is a claim about a person made by somebody else. The
   * journey still proceeds — this is an interface control on valueless testnet
   * software, not a compliance gate — but an unproven acceptance is recorded and
   * reported as unproven rather than as their affirmation.
   */
  claimFor({ address, version = TERMS_VERSION }) {
    return ["tradermarket-terms-v1", String(address).toLowerCase(), version].join("\n");
  }

  terms() {
    return {
      version: TERMS_VERSION,
      attestations: ELIGIBILITY_ATTESTATIONS.map((entry) => ({ ...entry })),
      notice: LEGAL_NOTICE,
      collateral_notice:
        "Collateral is Circle test USDC on a public test network and has no real-world value.",
      software_notice: "The contracts are unaudited. Do not use real funds.",
    };
  }

  /** Records acceptance. Every attestation must be individually affirmed. */
  async accept({ address, version, attestations = {}, claim = null, signature = null }) {
    if (!address) return { accepted: false, reason: "connect an account before accepting the terms" };
    // Every row here is a consent record: it says a specific account affirmed
    // its age, its understanding of the risk, and its jurisdiction. `String()`
    // accepted anything, so `{a:1}` became the account "[object object]" and a
    // 60,000-character string became a 60,000-byte primary key — in a table
    // sharing room.db with the event log, the chat audit and the gate nonce,
    // none of which is rebuildable. A claim about a subject that cannot exist
    // is worse than no claim.
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return { accepted: false, reason: "an account address must be 0x followed by 40 hex characters" };
    }
    if (version !== TERMS_VERSION) {
      return {
        accepted: false,
        reason: `these terms are version ${version ?? "unknown"}; the current version is ${TERMS_VERSION}`,
      };
    }
    const missing = ELIGIBILITY_ATTESTATIONS.filter((entry) => attestations[entry.id] !== true);
    if (missing.length > 0) {
      return {
        accepted: false,
        reason: `every attestation must be affirmed; ${missing.length} outstanding`,
        missing: missing.map((entry) => entry.id),
      };
    }
    // A supplied signature must verify. A signature that does not is a refusal,
    // never a quiet downgrade to "unproven".
    let proven = false;
    if (signature) {
      const expected = this.claimFor({ address, version: TERMS_VERSION });
      if (claim !== expected) {
        return { accepted: false, reason: "the signed statement does not match these terms" };
      }
      // "Cannot check" and "checked and wrong" are different answers, and only
      // one of them is about the caller.
      if (!this.verify) {
        return { accepted: false, reason: "this build cannot verify a signature, so it will not record one as proven" };
      }
      if (!(await this.verify(address, claim, signature))) {
        return { accepted: false, reason: "that signature does not verify for this address" };
      }
      proven = true;
    }

    const key = String(address).toLowerCase();
    await this.acceptances.set(key, TERMS_VERSION);
    // Proof only ever moves upwards. Anyone can post an unsigned acceptance for
    // any address, so letting one overwrite the flag would let a stranger
    // revoke what the real owner proved — and, with the gate keyed on it, lock
    // them out. Signing later upgrades an earlier unsigned acceptance.
    const proofRemembered = await this._rememberProof(key, proven);
    // One acceptance, recorded everywhere it is checked — but only a *proven*
    // one reaches the allowlist. Allowlisted addresses are public, so writing an
    // unproven acceptance into the object that gates the API would let a
    // stranger post someone else's address and then assert it in a header. The
    // journey still records the unproven acceptance so the reader is not stuck
    // in a loop; the gate is what waits for a signature.
    if (proofRemembered) await this.allowlist?.acceptTerms?.(address, TERMS_VERSION);
    return {
      accepted: true,
      version: TERMS_VERSION,
      proven,
      notice: proven
        ? "Recorded, and signed by this address."
        : "Recorded, but not proven: no signature accompanied it, so this is a self-declared acceptance rather than one this address demonstrably made.",
    };
  }

  async hasAccepted(address) {
    if (!address) return false;
    return (await this.acceptances.get(String(address).toLowerCase())) === TERMS_VERSION;
  }

  /** The journey, as the interface should render it. */
  async status(address) {
    const connected = Boolean(address);
    const accepted = await this.hasAccepted(address);
    const proven = accepted && (await this._isProven(address));
    // The allowlist is an in-memory enforcement object; hydrate it lazily from
    // the durable acceptance proof before asking it for a verdict. Otherwise a
    // process restart remembers the version but locks the same signed user out.
    if (proven) await this.allowlist?.acceptTerms?.(address, TERMS_VERSION);
    const allowlistEnabled = this.capabilities.available("allowlist") || this.allowlist?.enabled === true;
    const allowlistVerdict = allowlistEnabled && connected ? await this.allowlist.check(address) : null;
    const faucet = this.capabilities.config?.funding?.faucetUrl ?? null;

    const steps = [
      {
        id: "connect",
        title: "Connect an account",
        detail: connected
          ? "Connected. Your wallet signs every market action directly; this interface never holds your keys or your collateral."
          : "Connect a browser wallet on the test network. This interface never takes custody: your wallet signs every action.",
        state: connected ? "done" : "required",
      },
      {
        id: "terms",
        title: "Accept the testnet terms",
        detail: accepted
          ? proven
            ? `Accepted and signed by this address (version ${TERMS_VERSION}).`
            : `Accepted (version ${TERMS_VERSION}), self-declared: it was not proven with a signature.`
          : "Confirm your age, the testnet nature of this software, the risks, and your own jurisdiction.",
        state: accepted ? "done" : connected ? "required" : "waiting",
      },
      {
        id: "allowlist",
        title: "Interface allowlist",
        detail: allowlistEnabled
          ? allowlistVerdict?.allowed
            ? "This address is allowlisted for the interface."
            : accepted && !proven
              ? // The common stuck state, named rather than left as "terms not
                // accepted" when the reader has just accepted them.
                `You accepted the terms, but without a signature. Sign the acceptance with this wallet to satisfy the interface allowlist. ${LEGAL_NOTICE}`
              : `${allowlistVerdict?.reason ?? "connect an account"}. ${LEGAL_NOTICE}`
          : "The interface allowlist is not enabled in this deployment.",
        state: !allowlistEnabled
          ? "not_required"
          : !connected
            ? "waiting"
            : allowlistVerdict?.allowed
              ? "done"
              : "blocked",
      },
      {
        id: "funding",
        title: "Get test USDC",
        detail: faucet
          ? "Claim test USDC from the configured faucet, then return here. You also need a small amount of test POL for gas."
          : "A test-USDC faucet is not configured for this deployment. Ask the operator how to obtain test collateral.",
        url: faucet,
        state: faucet ? (connected ? "available" : "waiting") : "not_configured",
      },
    ];

    const blocking = steps.filter(
      (step) => step.state === "required" || step.state === "blocked" || step.state === "waiting"
    );

    return {
      can_enter: connected && accepted && (!allowlistEnabled || Boolean(allowlistVerdict?.allowed)),
      steps,
      blocking: blocking.map((step) => step.id),
      terms_version: TERMS_VERSION,
      gas_statement: this.capabilities.gasStatement(),
      notice: LEGAL_NOTICE,
    };
  }
}
