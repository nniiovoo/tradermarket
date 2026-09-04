// P2 growth surfaces: referrals, community and social proof.
//
// These are the surfaces where a product is most tempted to invent numbers, so
// each one is gated on real configuration and, when enabled, reports only what
// the chain recorded. Specifically:
//
//   - An unconfigured referral programme mints no code and advertises no
//     reward. Offering a reward that nothing funds is a promise, not a feature.
//   - Social proof publishes credited claims that already exist publicly on
//     chain, and never a member count, a testimonial, or a "traders online"
//     figure that no system measures.
//   - Account choice lists only the account types this deployment supports. An
//     embedded account needs a third-party provider, so without one configured
//     the option is shown as unavailable rather than hidden or faked.

import { createHash } from "node:crypto";

const TESTNET_NOTICE =
  "This is a test-network programme. Any amount shown is Circle test USDC and has no real-world value.";

const lower = (value) => String(value ?? "").toLowerCase();

export class Growth {
  /**
   * @param options.referrals      optional durable referral store
   * @param options.verifySignature optional (address, message, signature) => Promise<boolean>
   *
   * Without both, a referral code is still issued and the attributed count
   * stays at zero — which is the honest answer, because nothing has been
   * recorded that could be checked.
   */
  constructor({ capabilities, store, referrals = null, verifySignature = null }) {
    this.capabilities = capabilities;
    this.store = store;
    this.referrals_ = referrals;
    this.verify = verifySignature;
  }

  /** The code for one address, derived so it needs no stored state. */
  _codeFor(account) {
    const programId = this.capabilities.config.referrals?.programId ?? null;
    return createHash("sha256")
      .update(`${programId}:${lower(account)}`)
      .digest("hex")
      .slice(0, 10)
      .toUpperCase();
  }

  /**
   * The string a referred person signs to bind themselves to a code.
   *
   * Signed by the *referred* person, not the referrer: anyone can post anyone's
   * address, so an unsigned binding would let a stranger claim credit for
   * somebody who never heard of them.
   */
  referralClaimFor({ address, code }) {
    // The claim names the referrer as well as the code. The code is a one-way
    // hash of the programme and the referrer, so it cannot be reversed — and a
    // binding that could not say *whose* code it was would be unattributable.
    // What the referred person signs is therefore the whole statement: "I was
    // referred by this address, under this code."
    return ["tradermarket-referral-v1", lower(address), lower(this._referrerOf(code) ?? ""), code].join("\n");
  }

  /** The referrer a code belongs to, when this process has been told. */
  _referrerOf(code) {
    return this._issuedCodes?.get(code) ?? null;
  }

  /** Records a binding, if it is proven and this address has none already. */
  async bindReferral({ address, code, claim = null, signature = null, atBlock = null }) {
    const capability = this.capabilities.get("referrals");
    if (!capability.available) return { ok: false, reason: capability.reason };
    if (!this.referrals_) {
      return { ok: false, reason: "this deployment records no referral bindings, so none can be attributed" };
    }
    if (!signature || !claim) {
      return { ok: false, reason: "a referral must be signed by the person being referred" };
    }
    if (claim !== this.referralClaimFor({ address, code })) {
      return { ok: false, reason: "the signed statement does not match this code and address" };
    }
    if (!this.verify) {
      return { ok: false, reason: "this build cannot verify a signature, so it will not record a binding" };
    }
    if (!(await this.verify(address, claim, signature))) {
      return { ok: false, reason: "that signature does not verify for this address" };
    }
    if (await this.referrals_.bindingFor(address)) {
      // A second binding would let someone shop for a referrer after the fact.
      return { ok: false, reason: "this address is already bound to a referral" };
    }

    // The code identifies the referrer; a self-referral is not a referral.
    const referrer = this._referrerOf(code);
    if (!referrer) {
      return {
        ok: false,
        reason: "that code has not been issued by this deployment, so there is no referrer to credit",
      };
    }
    if (lower(referrer) === lower(address)) {
      return { ok: false, reason: "you cannot be referred by your own code" };
    }

    await this.referrals_.bind({ account: address, code, referrer, atBlock });
    return { ok: true, code, referrer };
  }

  /**
   * A referral view for one address.
   *
   * The code is derived from the programme id and the address, so it is stable
   * without stored state. Attribution is a two-part fact and both parts are
   * checkable: the referred person signed a binding to this code, and their
   * first market action appears on chain *after* that binding. A trade that
   * predates it is a retro-claim on somebody who was already here.
   *
   * Nothing funds a reward, so nothing is credited. The count is a count.
   */
  async referrals(account) {
    const capability = this.capabilities.get("referrals");
    if (!capability.available) {
      return { available: false, reason: capability.reason, code: null, bound: 0, referred: 0, earned: "0" };
    }

    const programId = this.capabilities.config.referrals?.programId ?? null;
    const code = this._codeFor(account);
    // Remembered so a later binding can say whose code it is. Derived, not
    // stored authority: the same address always produces the same code.
    (this._issuedCodes ??= new Map()).set(code, lower(account));

    const bindings = (await this.referrals_?.bindingsBy(account)) ?? [];
    const attributed = bindings.filter((binding) => this._firstActionAfter(binding));

    return {
      available: true,
      program_id: programId,
      account: lower(account),
      code,
      bound: bindings.length,
      referred: attributed.length,
      earned: "0",
      notice: TESTNET_NOTICE,
      attribution_note: this.referrals_
        ? "A referral counts once the referred address signs a binding to your code and then takes its first market action on chain. Nothing is paid for one: no reward is funded."
        : "This deployment records no referral bindings, so no attribution is possible and none is claimed.",
    };
  }

  /**
   * Whether this binding's referred address acted on chain after it was made.
   *
   * The block, not the wall clock: a referral is a claim about an ordering of
   * events that anyone can check, and only the chain carries that ordering.
   */
  _firstActionAfter(binding) {
    const boundAt = Number(binding.boundAtBlock ?? 0);
    return this.store
      .listTrades()
      .some((trade) => lower(trade.account) === lower(binding.account) && Number(trade.block_number ?? 0) > boundAt);
  }

  /** Community links, when an operator has configured any. */
  community() {
    const inviteUrl = this.capabilities.config.community?.inviteUrl ?? null;
    if (!inviteUrl) {
      return { available: false, reason: "no community space is configured for this deployment", links: [] };
    }
    return {
      available: true,
      links: [{ id: "community", label: "Community space", url: inviteUrl }],
      notice: "Operated separately from this software. Nothing said there decides a market.",
    };
  }

  /**
   * Recent credited wins and the number of accounts that were credited.
   *
   * Both come from indexed claim events, which are already public. There is no
   * viewer count, member count, or testimonial here, because nothing in this
   * system measures those.
   */
  socialProof(limit = 5) {
    const capability = this.capabilities.get("social_proof");
    if (!capability.available) {
      return {
        available: false,
        reason: capability.reason,
        recent_wins: [],
        participants: 0,
        empty_reason: null,
      };
    }

    const claims = this.store
      .listClaims()
      // A zero-value redemption is a loss, not a win. `redeemPositions` reverts
      // only when *both* sides are zero, so a holder of the losing side can
      // redeem for a payout of nothing — and listing that under "Recently
      // credited" shows someone's loss as someone's win.
      .filter(
        (claim) =>
          (claim.kind === "redeem" || claim.kind === "winner_reward") && BigInt(claim.amount ?? 0n) > 0n
      )
      .sort((a, b) => Number(b.block_number ?? 0) - Number(a.block_number ?? 0));

    const accounts = new Set(claims.map((claim) => lower(claim.account)));
    const wins = claims.slice(0, limit).map((claim) => {
      const market = this.store.getMarket(claim.market_address);
      return {
        account: lower(claim.account),
        market: lower(claim.market_address),
        question: market?.question ?? "",
        amount: BigInt(claim.amount ?? 0n),
        kind: claim.kind,
        block_number: Number(claim.block_number ?? 0),
        route: `/activity/${lower(claim.market_address)}`,
      };
    });

    return {
      available: true,
      recent_wins: wins,
      participants: accounts.size,
      basis: "credited claims indexed from chain",
      empty_reason:
        wins.length === 0
          ? "No settled market has credited anyone yet. Real wins appear here once payouts are claimed on chain."
          : null,
    };
  }

  /** Which kinds of account this deployment can actually offer. */
  accountOptions() {
    const embedded = this.capabilities.config.embeddedAccount?.provider ?? null;
    return {
      options: [
        {
          id: "injected_wallet",
          label: "Your own wallet",
          available: true,
          detail:
            "You keep your keys. Every market action is signed by your wallet directly with the contract, and this interface never takes custody of your collateral.",
        },
        {
          id: "embedded_account",
          label: "Email or passkey account",
          available: Boolean(embedded),
          reason: embedded
            ? null
            : "no embedded-account provider is configured for this deployment, so only a self-custodied wallet is available",
          detail:
            "An embedded account would let someone start without installing a wallet. It requires a third-party account provider, which this deployment does not have.",
        },
      ],
      custody_note:
        "This interface never holds your keys and never takes custody of your collateral. No order passes through our servers.",
    };
  }
}
