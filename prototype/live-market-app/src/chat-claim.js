/**
 * The exact string a chat post is signed over.
 *
 * This must stay identical to `ChatService.claimFor` in the room service. It
 * lives in its own module so there is one definition on this side rather than a
 * copy inline in a component: a change on the service side then shows up as a
 * single edit here, not as every client silently getting "claim does not match".
 *
 * Signing the bare message text would bind nothing — the same signature would
 * post in any room, on any deployment, forever, and any signature the reader had
 * ever produced over a plain string elsewhere would post as them here.
 */
export const CHAT_CLAIM_DOMAIN = "tradermarket-chat-v1";

export function chatClaim({ roomId, address, text, issuedAt }) {
  return [CHAT_CLAIM_DOMAIN, roomId, String(address).toLowerCase(), String(issuedAt), text].join("\n");
}

/**
 * The string a terms acceptance is signed over.
 *
 * Must stay identical to `EntryGate.claimFor` in the room service. The record
 * says a specific address affirmed statements about their own age, risk
 * understanding and jurisdiction, so signing it is what makes it theirs rather
 * than a claim somebody else made about them.
 */
export const TERMS_CLAIM_DOMAIN = "tradermarket-terms-v1";

export function termsClaim({ address, version }) {
  return [TERMS_CLAIM_DOMAIN, String(address).toLowerCase(), version].join("\n");
}
