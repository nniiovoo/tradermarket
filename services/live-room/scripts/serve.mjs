#!/usr/bin/env node
// Runs the Live Room Coordinator against a configured test network.
//
// It prints what it actually has and what it does not, then serves. If the
// configuration is incomplete it exits with the reason instead of starting a
// process that would answer the website with invented state.

import { verifyMessage } from "viem";

import { buildService, configFromEnv } from "../src/app.mjs";

const config = configFromEnv(process.env);

let service;
try {
  service = buildService(config, {
    // Chat identity: the signature must recover to the address that claims it.
    verifySignature: async (address, message, signature) => {
      try {
        return await verifyMessage({ address, message, signature });
      } catch {
        return false;
      }
    },
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const report = await service.start();
console.log(`Live Room Coordinator listening on port ${config.port}`);
console.log(`  room        ${report.room_id} at ${report.room}`);
console.log(`  chain       ${report.chain_id ?? "unspecified"} via ${config.rpcUrl}`);
console.log(`  software    ${report.software_notice}`);
console.log(`  history     ${report.durability.non_chain_history}`);
if (report.durability.non_chain_history !== "durable") {
  console.error(`  WARNING     ${report.durability.detail}`);
}
for (const [name, entry] of Object.entries(report.capabilities)) {
  console.log(`  ${entry.available ? "on " : "off"}  ${name.padEnd(18)} ${entry.available ? "" : entry.reason}`);
}

const shutdown = async () => {
  await service.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
