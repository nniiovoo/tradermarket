// Truthful capability reporting.
//
// Every consumer surface asks this module what actually exists. A capability is
// "available" only when the concrete thing it depends on is configured — never
// because a flag says so, and never because a sibling capability happens to be
// on. Gas sponsorship in particular is claimed only when a bundler, a paymaster,
// an entry point, AND a policy are all present, because telling a Forecaster
// their gas is covered when it is not is a lie they pay for.
//
// `legal_availability` is deliberately unsatisfiable: no deploy variable can
// make a legal conclusion true.

export const CAPABILITY_KEYS = [
  "live_room",
  "settlement_api",
  "livestream",
  "chat",
  "gas_sponsorship",
  "deployment",
  "funding_faucet",
  "allowlist",
  "referrals",
  "social_proof",
  "livestream_oracle",
  "legal_availability",
];

const SECRET_FIELDS = /key|secret|token|password|credential|private/i;

export class Capabilities {
  /**
   * @param config {
   *   room:      { apiUrl, roomId },
   *   stream:    { playbackUrl, provider },
   *   chat:      { enabled },
   *   paymaster: { bundlerUrl, paymasterUrl, entryPoint, policyId },
   *   chain:     { factory, chainId, marketAddress },
   *   funding:   { faucetUrl },
   *   allowlist: { enabled },
   *   referrals: { enabled, programId },
   *   socialProof:{ enabled },
   * }
   */
  constructor(config = {}) {
    this.config = config;
  }

  get(key) {
    const check = CHECKS[key];
    if (!check) throw new Error(`unknown capability ${key}`);
    return check(this.config);
  }

  available(key) {
    return this.get(key).available;
  }

  /** The exact sentence a surface may show about gas. Never optimistic. */
  gasStatement() {
    return this.available("gas_sponsorship")
      ? "Gas is sponsored for eligible actions under the configured paymaster policy."
      : "You pay your own gas in test POL. Gas sponsorship is not configured.";
  }

  /** Safe to serve publicly: no credential values, no credential field names. */
  publicSnapshot() {
    const capabilities = {};
    for (const key of CAPABILITY_KEYS) {
      const entry = this.get(key);
      capabilities[key] = { available: entry.available, reason: entry.reason };
    }
    const chainId = this.config.chain?.chainId ?? null;
    // Asserted about the configured chain, not assumed. Both statements are
    // true of every chain this software is meant for — which is exactly why
    // asserting them without looking is dangerous: a build pointed somewhere
    // else would reassure someone that their money is play money.
    const testnet = chainId === null ? null : TEST_NETWORKS.has(chainId);
    return {
      capabilities,
      // Structural facts, not secrets.
      testnet,
      collateral_notice:
        testnet === true
          ? "Collateral is Circle test USDC on a public test network and has no real-world value."
          : testnet === false
            ? `Chain ${chainId} is not a test network this build recognises. Treat any collateral here as real until you have checked.`
            : "The configured chain is not known to this build, so whether its collateral has real-world value is not known either.",
      gas_statement: this.gasStatement(),
      room_id: this.config.room?.roomId ?? null,
      chain_id: this.config.chain?.chainId ?? null,
      stream_provider: this.config.stream?.provider ?? null,
    };
  }

  /** Redacts anything credential-shaped, for logs and diagnostics. */
  static redact(config) {
    const walk = (value) => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
          out[key] = SECRET_FIELDS.test(key) ? "[redacted]" : walk(item);
        }
        return out;
      }
      return value;
    };
    return walk(config);
  }
}

function present(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

const CHECKS = {
  live_room: (config) => {
    if (!present(config.room?.apiUrl)) return no("no room API URL is configured");
    if (!present(config.room?.roomId)) return no("no room id is configured");
    return yes();
  },

  settlement_api: (config) => {
    if (!present(config.room?.apiUrl)) return no("no room API URL is configured to serve settlement records");
    // The service omits settlement records entirely without a participant
    // mapping — guessing which competitor is Outcome A would mislabel who won.
    // Reporting this available on an API URL alone told every reader a
    // settlement record existed for a market that has none.
    const keys = config.settlement?.participantKeys ?? {};
    if (!present(keys.a) || !present(keys.b)) {
      return no(
        "settlement records need the participant mapping (which competitor is Outcome A); without it they are omitted rather than guessed"
      );
    }
    return yes();
  },

  livestream: (config) =>
    present(config.stream?.playbackUrl) ? yes() : no("no livestream playback source is configured"),

  chat: (config) => {
    if (!present(config.room?.apiUrl)) return no("chat needs a room API URL");
    return config.chat?.enabled ? yes() : no("chat is not enabled in this deployment");
  },

  // Four separate things must exist. Endpoints without a policy still cannot
  // sponsor anything, and a policy without an entry point cannot be submitted.
  gas_sponsorship: (config) => {
    const paymaster = config.paymaster ?? {};
    // Report every missing piece at once: an operator fixing this needs the
    // whole list, and a surface rendering the reason should not imply that one
    // more endpoint is all that stands between a user and sponsored gas.
    const missing = [];
    if (!present(paymaster.bundlerUrl)) missing.push("an ERC-4337 bundler");
    if (!present(paymaster.paymasterUrl)) missing.push("a paymaster service");
    if (!present(paymaster.entryPoint)) missing.push("an entry point address");
    if (!present(paymaster.policyId)) missing.push("a sponsorship policy");
    // A policy that covers no action kind sponsors nothing. Four credentials
    // and an empty allow-list is a deployment that announces sponsorship and
    // declines every single request — the exact shape of claiming a capability
    // that does not exist.
    if (missing.length === 0 && (paymaster.sponsoredKinds ?? []).length === 0) {
      missing.push("a sponsorship policy that covers at least one action kind");
    }
    return missing.length === 0 ? yes() : no(`gas sponsorship needs ${missing.join(", ")}`);
  },

  deployment: (config) => {
    if (!present(config.chain?.factory)) return no("no factory address is configured");
    if (!config.chain?.chainId) return no("no chain id is configured");
    return yes();
  },

  funding_faucet: (config) =>
    present(config.funding?.faucetUrl) ? yes() : no("no test-USDC faucet is configured"),

  allowlist: (config) => (config.allowlist?.enabled ? yes() : no("the interface allowlist is not enabled")),

  referrals: (config) => {
    if (!config.referrals?.enabled) return no("no referral programme is configured");
    if (!present(config.referrals?.programId)) return no("no referral programme id is configured");
    return yes();
  },

  social_proof: (config) =>
    config.socialProof?.enabled ? yes() : no("community and social-proof surfaces are not configured"),

  livestream_oracle: (config) => {
    if (!present(config.oracle?.dataDir)) return no("livestream evidence needs durable storage");
    if (!config.oracle?.operatorTokenConfigured) return no("livestream evidence upload needs operator authentication");
    return yes();
  },

  // No configuration can satisfy this. It exists so surfaces can render the
  // honest answer rather than inventing one.
  legal_availability: () =>
    no(
      "legal review is not complete. This build is unaudited testnet software with no real-world value and makes no claim of legal availability in any jurisdiction."
    ),
};

/** Chains this build knows to be test networks. */
const TEST_NETWORKS = new Set([
  80002, // Polygon Amoy
  31337, // Anvil / Foundry
  11155111, // Sepolia
  84532, // Base Sepolia
]);

function yes() {
  return { available: true, reason: "configured" };
}

function no(reason) {
  return { available: false, reason };
}

/**
 * The paymaster settings, from the environment.
 *
 * One parser, used by the composition root. There used to be two — this file's
 * and the one inlined in app.mjs — and the inlined copy did not know about
 * sponsored kinds, so the only check that reads them could never pass. Every
 * deployment reported "gas sponsorship is not configured" no matter what the
 * operator had configured and paid for.
 */
export function paymasterFromEnv(env = process.env) {
  return {
    bundlerUrl: env.TM_BUNDLER_URL,
    paymasterUrl: env.TM_PAYMASTER_URL,
    entryPoint: env.TM_ENTRY_POINT,
    policyId: env.TM_PAYMASTER_POLICY_ID,
    sponsoredKinds: String(env.TM_PAYMASTER_SPONSORED_KINDS ?? "")
      .split(",")
      .map((kind) => kind.trim())
      .filter(Boolean),
  };
}

/** Builds capabilities from environment variables, for the API process. */
export function capabilitiesFromEnv(env = process.env) {
  return new Capabilities({
    room: { apiUrl: env.TM_ROOM_API_URL, roomId: env.TM_ROOM_ID },
    stream: { playbackUrl: env.TM_STREAM_PLAYBACK_URL, provider: env.TM_STREAM_PROVIDER },
    chat: { enabled: env.TM_CHAT_ENABLED === "true" },
    paymaster: paymasterFromEnv(env),
    settlement: { participantKeys: { a: env.TM_PARTICIPANT_A, b: env.TM_PARTICIPANT_B } },
    chain: {
      factory: env.TM_FACTORY_ADDRESS,
      chainId: env.TM_CHAIN_ID ? Number(env.TM_CHAIN_ID) : null,
    },
    funding: { faucetUrl: env.TM_FAUCET_URL },
    allowlist: { enabled: env.TM_ALLOWLIST_ENABLED === "true" },
    referrals: { enabled: env.TM_REFERRALS_ENABLED === "true", programId: env.TM_REFERRAL_PROGRAM_ID },
    socialProof: { enabled: env.TM_SOCIAL_PROOF_ENABLED === "true" },
    oracle: {
      dataDir: env.TM_DATA_DIR,
      operatorTokenConfigured: Boolean(env.TM_ORACLE_OPERATOR_TOKEN),
    },
  });
}
