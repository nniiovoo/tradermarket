// The signing port.
//
// Issue 05 required "the signing key in a KMS or hardware-backed signer with an
// allow-list of the room's function selectors" and was marked resolved. Neither
// half existed: every operator called `privateKeyToAccount(env.TM_*_KEY)`
// directly, so there was no seam a managed signer could be fitted into, and
// nothing constrained what a compromised key could be made to sign.
//
// This is the seam. The whole surface the services use of a signing account is
// three members — `address`, `signMessage`, `signTypedData` — plus whatever viem
// needs to send a transaction. viem's `toAccount` accepts exactly that shape, so
// a KMS-backed adapter is a matter of supplying three async functions; nothing
// above this file changes.
//
// The selector allow-list lives HERE rather than in the chain port, because here
// it covers every adapter — the raw-key one, the managed one nobody has chosen
// yet, and anything else. A guard in the chain port would be a guard one
// `writeContract` call could route around.

import { privateKeyToAccount } from "viem/accounts";

/**
 * The room functions each authority is permitted to sign a transaction for.
 *
 * Derived from what each role actually calls, and deliberately narrow. The gate
 * gates and closes; it does not publish. The publisher publishes; it does not
 * gate. A resolver attests; it does nothing else. A connector signs the event
 * log and no transaction at all, which is why it has an empty list rather than
 * a missing one — "signs nothing on chain" is a rule, not an oversight.
 */
export const ROLE_SELECTORS = {
  gate: [
    "markRoomEpochsSafe",
    "processRoom",
    "closeSlots",
    "closeRoom",
    "closeRemainingSlots",
    "suspendRoom",
    "reopenRoom",
  ],
  publisher: ["publishSlot"],
  // Both halves of resolution. `attestChallengeVerdict` was added here only once
  // the resolver service actually sent it (issue 24) — the allow-list states what
  // this build does, never what it might one day do.
  resolver: ["attestResult", "attestChallengeVerdict"],
  connector: [],
  // The keeper holds a key only because a transaction costs gas. Every function
  // here is permissionless — anyone may call them, and the contract itself
  // decides whether it is time — so this list confers no authority at all. That
  // is the point: a leaked keeper key can finalize markets that were already
  // finalizable, and nothing else. It must never gain `attestResult`,
  // `publishSlot`, `closeRoom` or anything that decides an outcome, or the role
  // separation the rest of this file exists to enforce would be one key away
  // from meaningless.
  keeper: ["finalizeUnchallenged", "expireChallenge", "invalidateUnresolved"],
};

/** Thrown when a signer is asked to sign a call it is not permitted to make. */
export class SelectorNotAllowed extends Error {
  constructor(selector, role) {
    super(
      `the ${role} signer refused to sign a transaction for selector ${selector}: ` +
        `it is not in this role's allow-list (${(ROLE_SELECTORS[role] ?? []).join(", ") || "none"})`
    );
    this.name = "SelectorNotAllowed";
    this.selector = selector;
    this.role = role;
  }
}

/**
 * Computes the 4-byte selectors a role may sign for, from an ABI.
 *
 * Taking them from the ABI rather than hardcoding hex means a renamed or
 * re-signatured function fails loudly at startup instead of silently dropping
 * out of the allow-list — which would turn a tightened guard into an open one.
 */
export function selectorsFor(role, abi, { toSelector }) {
  const names = ROLE_SELECTORS[role] ?? [];
  const allowed = new Set();
  for (const name of names) {
    const entry = abi.find((item) => item.type === "function" && item.name === name);
    if (!entry) {
      throw new Error(
        `the ${role} allow-list names "${name}", which is not a function in the ABI this build compiled against`
      );
    }
    allowed.add(toSelector(entry));
  }
  return allowed;
}

/**
 * A signing account for one role.
 *
 * Returns a viem-compatible account, so every caller — including
 * `createWalletClient` — is unaffected by which adapter produced it.
 *
 * @param options.role            one of the operator roles
 * @param options.privateKey      raw key adapter; the only one implemented today
 * @param options.allowedSelectors Set of 4-byte hex selectors, or null to allow all
 */
export function createSigner({ role, privateKey, allowedSelectors = null }) {
  if (!privateKey) throw new Error(`the ${role} signer needs a key`);
  const account = privateKeyToAccount(privateKey);

  // No allow-list configured means no restriction. That is the honest default
  // for a build that has not been told the room's ABI, and it is why the
  // deployment path passes one explicitly rather than relying on this.
  if (!allowedSelectors) return account;

  const guarded = {
    ...account,
    async signTransaction(transaction, options) {
      const data = transaction?.data;
      // A transaction with no calldata moves value and calls nothing. None of
      // these roles has a reason to send one, so it is refused rather than
      // waved through as "not a function call".
      const selector = typeof data === "string" && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "0x";
      if (!allowedSelectors.has(selector)) throw new SelectorNotAllowed(selector, role);
      return account.signTransaction(transaction, options);
    },
  };
  return guarded;
}
