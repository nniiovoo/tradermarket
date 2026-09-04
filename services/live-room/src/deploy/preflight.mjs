// Deployment preflight.
//
// A public deployment needs a funded signer, which is not something this repo
// can supply. Everything around that is checkable, and checking it before
// anyone spends is the difference between a deployment and a debugging session
// with real gas.
//
// It sends nothing. Its whole job is to say what would fail, and to separate
// what blocks from what is merely worth knowing — an operator who is paged for
// every thin balance stops reading the output.

/** Wei below which an authority cannot reliably act. */
export const DEFAULT_MINIMUM_WEI = 50_000_000_000_000_000n; // 0.05

/** Authorities that must be distinct, and why. */
const MUST_DIFFER = [
  ["gate", "publisher", "publication needs the publisher role AND a gate signature; one key holding both makes the pair meaningless"],
  ["gate", "resolver1", "a gate that can also attest can settle a market it gated"],
  ["gate", "resolver2", "a gate that can also attest can settle a market it gated"],
  ["gate", "resolver3", "a gate that can also attest can settle a market it gated"],
  ["publisher", "resolver1", "a publisher that can also attest can settle a market it wrote"],
  ["publisher", "resolver2", "a publisher that can also attest can settle a market it wrote"],
  ["publisher", "resolver3", "a publisher that can also attest can settle a market it wrote"],
  ["resolver1", "resolver2", "a quorum of two needs two different resolvers"],
  ["resolver1", "resolver3", "a quorum of two needs two different resolvers"],
  ["resolver2", "resolver3", "a quorum of two needs two different resolvers"],
  // The adjudicator upholds Integrity Claims, which moves a participant's whole
  // 100 USDC bond. It was absent from this table, so a room could be deployed
  // with the bond-seizing power welded to the key that gates it, publishes into
  // it, or attests its results — and the preflight would report it ready.
  ["adjudicator", "gate", "an adjudicator that also gates can seize a bond in a room it gated"],
  ["adjudicator", "publisher", "an adjudicator that also publishes can seize a bond in a market it wrote"],
  ["adjudicator", "resolver1", "an adjudicator that can also attest decides the result AND the bond"],
  ["adjudicator", "resolver2", "an adjudicator that can also attest decides the result AND the bond"],
  ["adjudicator", "resolver3", "an adjudicator that can also attest decides the result AND the bond"],
  // A resolver rebuilds the result from raw provider bytes, independently of
  // the connector that signed them (ADR 0024). One key holding both attests to
  // facts it produced itself, which is not a reconstruction — and the failure is
  // silent until a settlement is disputed.
  ["connector", "resolver1", "a resolver holding the connector key attests facts it signed itself"],
  ["connector", "resolver2", "a resolver holding the connector key attests facts it signed itself"],
  ["connector", "resolver3", "a resolver holding the connector key attests facts it signed itself"],
  ["connector", "gate", "a gate that also signs the source log gates on evidence it authored"],
  ["connector", "publisher", "a publisher that also signs the source log publishes against its own facts"],
  // The keeper is different in kind from every pair above, and the reason is
  // worth stating rather than inheriting. It holds NO authority — every
  // function it may call is permissionless, so sharing its address with an
  // authority grants that authority nothing it did not already have. The
  // separation is operational: two processes signing with one key fetch the
  // same nonce and drop each other's transactions, and the symptom is an
  // authority that intermittently fails to act with no error that names why.
  ["keeper", "gate", "two processes signing with one key contend for nonces and drop each other's transactions"],
  ["keeper", "publisher", "two processes signing with one key contend for nonces and drop each other's transactions"],
  ["keeper", "connector", "two processes signing with one key contend for nonces and drop each other's transactions"],
  ["keeper", "resolver1", "two processes signing with one key contend for nonces and drop each other's transactions"],
  ["keeper", "resolver2", "two processes signing with one key contend for nonces and drop each other's transactions"],
  ["keeper", "resolver3", "two processes signing with one key contend for nonces and drop each other's transactions"],
  ["keeper", "adjudicator", "two processes signing with one key contend for nonces and drop each other's transactions"],
];

export function preflight({
  chainId = null,
  expectedChainId = null,
  usdc = null,
  usdcIsContract = null,
  balances = {},
  authorities = {},
  minimumWei = DEFAULT_MINIMUM_WEI,
} = {}) {
  const blocking = [];
  const warnings = [];

  if (expectedChainId !== null && chainId !== null && Number(chainId) !== Number(expectedChainId)) {
    blocking.push(
      `the RPC endpoint is chain ${chainId}, but this deployment expects chain ${expectedChainId}. Deploying to the wrong chain is not recoverable by editing configuration.`
    );
  }

  if (usdcIsContract === false) {
    blocking.push(
      `the collateral address ${usdc} has no code on this chain. A market created against it would accept deposits nothing can return.`
    );
  } else if (usdcIsContract === null) {
    warnings.push("the collateral address was not checked, so whether it is a contract on this chain is unknown");
  }

  const seen = new Map();
  for (const [role, address] of Object.entries(authorities)) {
    if (!address) {
      blocking.push(`${role} has no address configured`);
      continue;
    }
    const key = String(address).toLowerCase();
    if (seen.has(key)) seen.get(key).push(role);
    else seen.set(key, [role]);
  }
  for (const [a, b, why] of MUST_DIFFER) {
    const left = authorities[a];
    const right = authorities[b];
    if (left && right && String(left).toLowerCase() === String(right).toLowerCase()) {
      blocking.push(`${a} and ${b} are the same address: ${why}`);
    }
  }

  // Each signer named individually. A total would hide which one cannot act,
  // and the operator would fund the wrong wallet.
  for (const [role, balance] of Object.entries(balances)) {
    const wei = BigInt(balance ?? 0n);
    if (wei < minimumWei) {
      blocking.push(
        `${role} holds ${wei} wei, below the ${minimumWei} wei it needs to act. It will not be able to send its transactions.`
      );
    } else if (wei < minimumWei * 2n) {
      warnings.push(`${role} holds ${wei} wei — above the minimum, but thin enough to run out during a session`);
    }
  }

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    checked: {
      chain_id: chainId,
      expected_chain_id: expectedChainId,
      collateral: usdc,
      collateral_is_contract: usdcIsContract,
      authorities: Object.fromEntries(Object.entries(authorities)),
      balances: Object.fromEntries(Object.entries(balances).map(([role, wei]) => [role, String(wei)])),
    },
    notice:
      "This is a preflight: no transaction was sent, and nothing has been created on chain. It reports only what would fail if one were.",
  };
}
