// Gas sponsorship abstraction (P0).
//
// This module's most important behaviour is refusal. Until a bundler, a
// paymaster service, an entry point, and a sponsorship policy all exist, every
// request is declined with a reason and the caller is told that the user pays
// their own gas. A declined quote never carries a user operation, so no caller
// can mistake a refusal for a sponsorship.
//
// It is provider-agnostic on purpose: ERC-4337 paymaster services differ in
// their RPC envelopes but not in the shape of this decision, and naming a vendor
// here would bake a procurement choice into the protocol layer.

/** Who pays, when nobody is sponsoring. */
const USER_PAYS = "user (test POL)";

export class GasPolicy {
  /**
   * @param options.allowedKinds        action kinds eligible for sponsorship
   * @param options.maxSponsoredWeiPerAction  hard ceiling per action
   * @param options.dailyWeiPerAccount  optional per-account daily ceiling
   */
  constructor({ allowedKinds = [], maxSponsoredWeiPerAction = null, dailyWeiPerAccount = null } = {}) {
    this.allowedKinds = new Set(allowedKinds);
    this.maxSponsoredWeiPerAction = maxSponsoredWeiPerAction;
    this.dailyWeiPerAccount = dailyWeiPerAccount;
    this.spentToday = new Map();
  }

  /** Returns null when allowed, or a reason string when not. */
  reject(action) {
    if (!this.allowedKinds.has(action.kind)) {
      return `action kind "${action.kind}" is not covered by the sponsorship policy`;
    }
    const estimated = action.estimatedGasWei ?? 0n;
    if (this.maxSponsoredWeiPerAction !== null && estimated > this.maxSponsoredWeiPerAction) {
      return `estimated gas exceeds the per-action sponsorship ceiling`;
    }
    if (this.dailyWeiPerAccount !== null) {
      const spent = this.spentToday.get(String(action.account).toLowerCase()) ?? 0n;
      if (spent + estimated > this.dailyWeiPerAccount) {
        return `this account exceeds its daily sponsorship allowance`;
      }
    }
    return null;
  }

  record(action) {
    const estimated = action.estimatedGasWei ?? 0n;
    // Normalised: address case is a checksum, so keying on the raw string gave
    // each of an address's case variants its own fresh daily allowance.
    const account = String(action.account).toLowerCase();
    this.spentToday.set(account, (this.spentToday.get(account) ?? 0n) + estimated);
  }
}

function declined(reason) {
  return { sponsored: false, reason, payer: USER_PAYS, userOperation: null };
}

/** The state this deployment is actually in. */
export class UnconfiguredPaymaster {
  constructor(reason) {
    this.available = false;
    this.reason = reason;
  }

  async sponsor() {
    // Lead with the plain fact, then the specifics. A caller rendering only the
    // first clause still tells the user the truth.
    return declined(`gas sponsorship is not configured: ${this.reason}`);
  }

  statement() {
    return `You pay your own gas in test POL. Gas sponsorship is not configured: ${this.reason}.`;
  }
}

/** A configured ERC-4337 paymaster, reached over its JSON-RPC endpoint. */
export class HttpPaymaster {
  constructor({ config, transport, policy }) {
    this.config = config;
    this.transport = transport;
    this.policy = policy ?? new GasPolicy({});
    this.available = true;
    this.reason = "configured";
  }

  async sponsor(action) {
    const rejection = this.policy.reject(action);
    // The policy is checked BEFORE the provider is asked: an ineligible action
    // should never cost a round trip, and never look eligible in provider logs.
    if (rejection) return declined(rejection);

    let response;
    try {
      response = await this.transport(this.config.paymasterUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "pm_sponsorUserOperation",
        params: [
          {
            sender: action.account,
            callTarget: action.market ?? null,
            kind: action.kind,
          },
          this.config.entryPoint,
          { policyId: this.config.policyId },
        ],
      });
    } catch (error) {
      // A provider outage is not a sponsorship. The user pays, and is told.
      return declined(`the paymaster service is unavailable (${error.message})`);
    }

    const result = response?.result ?? null;
    if (!result || !result.paymasterAndData) {
      return declined("the paymaster returned no paymaster data for this action");
    }
    this.policy.record(action);
    return {
      sponsored: true,
      reason: "sponsored under the configured policy",
      payer: "paymaster",
      userOperation: result,
    };
  }

  statement() {
    return "Gas is sponsored for eligible actions under the configured paymaster policy.";
  }
}

/**
 * Builds the paymaster this deployment actually has. Partial configuration
 * yields an UnconfiguredPaymaster carrying the reason — never a half-working
 * provider that fails at signing time.
 */
export function createPaymaster({ capabilities, transport = defaultTransport, policy = null }) {
  const entry = capabilities.get("gas_sponsorship");
  if (!entry.available) return new UnconfiguredPaymaster(entry.reason);
  const config = capabilities.config.paymaster ?? {};
  // Built from the same configuration the capability was checked against, so
  // the policy the interface promises is the policy the paymaster applies. A
  // default empty policy would decline everything the capability announced.
  const configured =
    policy ??
    new GasPolicy({
      allowedKinds: config.sponsoredKinds ?? [],
      maxSponsoredWeiPerAction: config.maxSponsoredWeiPerAction ?? null,
      dailyWeiPerAccount: config.dailyWeiPerAccount ?? null,
    });
  return new HttpPaymaster({ config, transport, policy: configured });
}

async function defaultTransport(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
