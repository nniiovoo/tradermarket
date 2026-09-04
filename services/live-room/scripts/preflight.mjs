#!/usr/bin/env node
// Checks a deployment before anyone spends.
//
//   TM_RPC_URL=… TM_EXPECTED_CHAIN_ID=80002 TM_USDC=0x… \
//   TM_GATE=0x… TM_PUBLISHER=0x… TM_RESOLVER_1=0x… TM_RESOLVER_2=0x… TM_RESOLVER_3=0x… \
//   TM_DEPLOYER=0x… npm run preflight
//
// Sends nothing. It reads balances and code, and reports what would fail.

import { createPublicClient, http } from "viem";
import { preflight, DEFAULT_MINIMUM_WEI } from "../src/deploy/preflight.mjs";

const env = process.env;
if (!env.TM_RPC_URL) {
  console.error("TM_RPC_URL is required: the preflight reads the chain you intend to deploy to.");
  process.exit(1);
}

const client = createPublicClient({ transport: http(env.TM_RPC_URL) });

const authorities = {
  deployer: env.TM_DEPLOYER ?? null,
  gate: env.TM_GATE ?? null,
  publisher: env.TM_PUBLISHER ?? null,
  resolver1: env.TM_RESOLVER_1 ?? null,
  resolver2: env.TM_RESOLVER_2 ?? null,
  resolver3: env.TM_RESOLVER_3 ?? null,
  // Optional, and checked only when supplied: a deployment that does not name
  // them cannot be told whether they collide, and saying nothing is honest.
  adjudicator: env.TM_ADJUDICATOR ?? null,
  connector: env.TM_CONNECTOR ?? null,
};

/**
 * Every chain read, with the endpoint named when one fails.
 *
 * The most ordinary way a preflight goes wrong is that the RPC endpoint is not
 * there, and the raw failure is a stack trace pointing inside a library. An
 * operator about to spend on a deployment cannot tell from that whether their
 * URL is a typo or their deployment is unsafe — which is the one question this
 * tool exists to answer.
 */
async function read(what, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`Could not ${what} at ${env.TM_RPC_URL}.`);
    console.error(`  ${error.shortMessage ?? error.message?.split("\n")[0] ?? error}`);
    console.error("\nNothing was checked, so nothing is cleared. Fix the endpoint and run this again.");
    process.exit(1);
  }
}

const chainId = await read("reach the chain", () => client.getChainId());
const usdc = env.TM_USDC ?? null;
const usdcIsContract = usdc
  ? (await read(`read the collateral contract at ${usdc}`, () => client.getCode({ address: usdc })))?.length > 2
  : null;

const balances = {};
for (const [role, address] of Object.entries(authorities)) {
  if (!address) continue;
  balances[role] = await read(`read the ${role} balance`, () => client.getBalance({ address }));
}

const result = preflight({
  chainId,
  expectedChainId: env.TM_EXPECTED_CHAIN_ID ? Number(env.TM_EXPECTED_CHAIN_ID) : null,
  usdc,
  usdcIsContract,
  balances,
  authorities,
  minimumWei: env.TM_MINIMUM_WEI ? BigInt(env.TM_MINIMUM_WEI) : DEFAULT_MINIMUM_WEI,
});

console.log(`chain ${chainId}${env.TM_EXPECTED_CHAIN_ID ? ` (expected ${env.TM_EXPECTED_CHAIN_ID})` : ""}`);
for (const [role, wei] of Object.entries(result.checked.balances)) {
  console.log(`  ${role.padEnd(10)} ${authorities[role]}  ${Number(BigInt(wei)) / 1e18} native`);
}
if (result.warnings.length > 0) {
  console.log("\nworth knowing:");
  for (const line of result.warnings) console.log(`  - ${line}`);
}
if (result.blocking.length > 0) {
  console.error("\nblocking:");
  for (const line of result.blocking) console.error(`  - ${line}`);
}
console.log(`\n${result.notice}`);
console.log(result.ok ? "\nPreflight passed. The deployment transactions are yours to send." : "\nPreflight failed.");
process.exit(result.ok ? 0 : 1);
