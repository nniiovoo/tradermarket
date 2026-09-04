// Canonical slot-request hashing, mirroring LiveRoom.slotRequestHash exactly.
//
// The Publication Permit binds this hash, so it must cover EVERYTHING the
// publisher supplies — template id, both parameter hashes, announce delay,
// winner setting, the question text, both media URLs, and the per-slot
// restricted-wallet list in order. Anything left out is something the publisher
// could vary after the gate signed.
//
// The game day asserts this JS implementation equals the deployed contract's
// output; a divergence here would silently break publication.

import { encodeAbiParameters, encodePacked, keccak256, toHex, stringToHex } from "viem";

/** Pads a short ASCII identifier into bytes32, as the contracts do. */
export function toBytes32(value) {
  if (typeof value === "string" && value.startsWith("0x") && value.length === 66) return value;
  const hex = Buffer.from(String(value), "utf8").toString("hex");
  if (hex.length > 64) throw new Error(`too long for bytes32: ${value}`);
  return `0x${hex.padEnd(64, "0")}`;
}

/**
 * @param request  { templateId, templateParamsHash, conditionHash, announceDelay,
 *                   winnerRewardBps, question, streamUrl, imageUrl }
 * @param restricted array of addresses, in the order they will be submitted
 */
export function slotRequestHash(request, restricted = []) {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint16" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      toBytes32(request.templateId),
      request.templateParamsHash,
      request.conditionHash,
      BigInt(request.announceDelay),
      Number(request.winnerRewardBps),
      keccak256(stringToHex(request.question ?? "")),
      keccak256(stringToHex(request.streamUrl ?? "")),
      keccak256(stringToHex(request.imageUrl ?? "")),
      restricted.length === 0 ? keccak256("0x") : keccak256(encodePacked(["address[]"], [restricted])),
    ]
  );
  return keccak256(encoded);
}
