// Testnet access gate (issue 17).
//
// This is an INTERFACE control, not a protocol control. An allowlist restricts
// who uses TraderMarket's interface, not who can transact with a deployed
// market: the contracts stay permissionless apart from the restricted wallet
// list. The real containment in this phase is that the collateral is Circle
// test USDC with no real-world value.
//
// Nothing here can affect settlement. Disabling the allowlist entirely changes
// no market behaviour.

import { TERMS_VERSION } from "../entry/entry.mjs";

export const DENIAL_COPY =
  "This interface is limited to allowlisted testnet accounts while legal review is pending. " +
  "This restricts the interface only: the contracts remain open on a public test network, " +
  "and the collateral is Circle test USDC with no real-world value. It is not a jurisdiction guarantee.";

export class Allowlist {
  /**
   * @param options.addresses  iterable of allowed addresses (case-insensitive)
   * @param options.terms      map address -> accepted terms version
   * @param options.enabled    when false, everything is allowed
   */
  constructor({ addresses = [], terms = new Map(), enabled = true, requiredTermsVersion = TERMS_VERSION } = {}) {
    this.addresses = new Set([...addresses].map((address) => String(address).toLowerCase()));
    this.terms = terms;
    this.enabled = enabled;
    this.requiredTermsVersion = requiredTermsVersion;
  }

  // check() and acceptTerms() are async because `terms` may be the durable
  // proven-acceptances store directly (app.mjs's provenAcceptances), which
  // must answer correctly on the very first gated request after a restart —
  // before any in-process cache could have been warmed. A Map still works
  // fine here too: `await plainValue` is a plain value.
  async check(address) {
    if (!this.enabled) return { allowed: true };
    if (!address) return { allowed: false, reason: "no address supplied", copy: DENIAL_COPY };
    const key = String(address).toLowerCase();
    if (!this.addresses.has(key)) return { allowed: false, reason: "not allowlisted", copy: DENIAL_COPY };
    if ((await this.terms.get(key)) !== this.requiredTermsVersion) {
      return { allowed: false, reason: "testnet terms not accepted", copy: DENIAL_COPY };
    }
    return { allowed: true };
  }

  async acceptTerms(address, version) {
    await this.terms.set(String(address).toLowerCase(), version);
  }

  add(address) {
    this.addresses.add(String(address).toLowerCase());
  }
}
