#!/usr/bin/env node
// Queues one question for publication, durably, and exits.
//
//   node scripts/queue-question.mjs --template tpl-participant-v1 --param target=10000
//
// The question text is RENDERED from the template and its params, not typed.
// It used to be a free-text flag that nothing reconciled against the rule, so
//   --question "Who reaches $5,000 first?" --param target=10000
// published cleanly and was immutable on chain: every forecaster read one
// claim and traded against another (issue 43). `--question` is still accepted
// and must now match what the template renders, so an operator can confirm the
// wording and cannot change the claim.
//
// This is deliberately a separate command rather than an endpoint on the
// Coordinator. The Coordinator holds no key and decides nothing; WHICH question
// to publish is an operator's decision, and the publisher process is the only
// thing that acts on it. All this does is write the request where the publisher
// will find it — including after a restart, which is the point of the queue.

import { openDatabase } from "../src/ports/sqlite-stores.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";
import { operatorConfigFromEnv } from "../src/operators.mjs";
import { firstTemplateCatalog, renderQuestion, assertQuestionMatches } from "../src/publisher/publisher.mjs";

function parseArgs(argv) {
  const args = { params: {}, restricted: [] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--template") args.templateId = value, index++;
    else if (flag === "--question") args.question = value, index++;
    else if (flag === "--slot") args.slotIndex = Number(value), index++;
    else if (flag === "--announce-delay") args.announceDelay = Number(value), index++;
    else if (flag === "--stream-url") args.streamUrl = value, index++;
    else if (flag === "--image-url") args.imageUrl = value, index++;
    else if (flag === "--restrict") args.restricted.push(value), index++;
    else if (flag === "--param") {
      const [key, ...rest] = String(value).split("=");
      args.params[key] = rest.join("=");
      index++;
    } else {
      console.error(`unknown argument ${flag}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = operatorConfigFromEnv(process.env);

const missing = [];
if (!config.roomId) missing.push("TM_ROOM_ID");
if (!config.dataDir) missing.push("TM_DATA_DIR");
if (!args.templateId) missing.push("--template");
if (missing.length > 0) {
  console.error(`Cannot queue a question: ${missing.join(", ")} is missing.`);
  process.exit(1);
}

// Rendered here as well as re-checked by the publisher and again by the gate.
// Doing it at the CLI is not the safety property — it is the courtesy of
// failing while the operator is still at the keyboard, instead of leaving a
// request in the queue that the gate will silently refuse.
const catalog = firstTemplateCatalog({ participants: config.participants });
let question;
try {
  question = args.question
    ? assertQuestionMatches(catalog, args.templateId, args.params, args.question)
    : renderQuestion(catalog, args.templateId, args.params);
} catch (error) {
  console.error(`Cannot queue a question: ${error.message}`);
  process.exit(1);
}

const database = openDatabase(`${config.dataDir}/room.db`);
const queue = new SqlitePublicationQueue(database, config.roomId);
const { id } = await queue.submit({
  slotIndex: args.slotIndex ?? null,
  templateId: args.templateId,
  params: args.params,
  question,
  announceDelay: args.announceDelay ?? config.announceDelayS,
  streamUrl: args.streamUrl ?? "",
  imageUrl: args.imageUrl ?? "",
  restricted: args.restricted,
});
database.close();

console.log(`queued request ${id} (${args.templateId}) for room ${config.roomId}`);
console.log(`  ${question}`);
console.log("The publisher will validate it, ask the gate for a permit, and publish it.");
