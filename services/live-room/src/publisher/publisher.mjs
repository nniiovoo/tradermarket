// Program Publisher (issue 08): the isolated signer holding
// PROGRAM_PUBLISHER_ROLE. It chooses WHICH approved question to instantiate
// and WHEN; it does not and cannot decide whether the question is still open.
//
// Publication needs both authorities: this service's role, and a Gate-signed
// Publication Permit. A refused permit is a normal outcome, not an error to
// retry blindly. The publisher key can never call a gate or resolution
// function — those roles live elsewhere.
//
// This class takes the GateAuthority as an argument and does the whole
// publication in one call, which means the caller holds both objects. That is
// right for a game day driving every component in one process, and wrong for
// production, where the gate is a different process holding a different key.
// `publisher/queue.mjs` is the production shape: it asks through a durable
// queue and waits, and `operators.mjs` builds that one. The catalogue below is
// shared by both — there is one approved list, not two.

export class ProgramPublisher {
  /**
   * @param options.chain       port: { publishSlot(request, permit, signature, restricted) }
   * @param options.gate        GateAuthority (permit issuer) — separate service in production
   * @param options.catalog     approved templates: Map templateId -> { shape, winnerRewardBps, buildCondition(params) }
   * @param options.config      { minAnnounceDelay }
   */
  constructor({ chain, gate, catalog, config }) {
    this.chain = chain;
    this.gate = gate;
    this.catalog = catalog;
    this.config = config;
    this.queue = [];
  }

  _record(entry) {
    this.queue.push({ at: new Date().toISOString(), ...entry });
    return entry;
  }

  /**
   * Validates a candidate against the approved catalog, requests a permit, and
   * publishes. Every rejection carries a legible reason.
   */
  async requestSlot(candidate) {
    const rule = this.catalog.get(candidate.templateId);
    if (!rule) {
      return this._record({ status: "rejected", reason: `template ${candidate.templateId} not approved`, candidate });
    }
    const announceDelay = candidate.announceDelay ?? this.config.minAnnounceDelay;
    if (announceDelay < this.config.minAnnounceDelay) {
      return this._record({ status: "rejected", reason: "announce delay below the frozen minimum", candidate });
    }

    let conditionDocument;
    try {
      conditionDocument = rule.buildCondition(candidate.params);
    } catch (error) {
      return this._record({ status: "rejected", reason: `bad params: ${error.message}`, candidate });
    }

    // The words and the rule must agree. Derived when the caller supplies no
    // text, checked when it does — an operator may still choose the phrasing
    // this build renders, and may not choose a different claim.
    let question;
    try {
      question = String(candidate.question ?? "").trim()
        ? assertQuestionMatches(this.catalog, candidate.templateId, candidate.params, candidate.question)
        : renderQuestion(this.catalog, candidate.templateId, candidate.params);
    } catch (error) {
      return this._record({ status: "rejected", reason: error.message, candidate });
    }

    // The gate must see the COMPLETE request it is being asked to attest,
    // including the per-slot restricted-wallet list, because that is what the
    // permit binds. Anything the publisher keeps back is something it could
    // change afterwards.
    const restricted = candidate.restricted ?? [];
    const request = {
      templateId: candidate.templateId,
      templateParamsHash: null, // the gate computes this itself
      conditionHash: null, // and this
      announceDelay,
      winnerRewardBps: rule.winnerRewardBps,
      question,
      streamUrl: candidate.streamUrl ?? "",
      imageUrl: candidate.imageUrl ?? "",
    };
    const permitResult = await this.gate.requestPermit({
      slotIndex: candidate.slotIndex,
      templateId: candidate.templateId,
      params: candidate.params,
      conditionDocument,
      announceDelay,
      request,
      restricted,
      // The clock the session is being run on. The gate refuses to authorise a
      // market on a source that has stopped reporting, and it has to measure
      // that against the same clock the caller is using — not wall time, which
      // a replay or a test drives nowhere near.
      nowMs: candidate.nowMs,
    });
    if (permitResult.refused) {
      // A refused permit is a normal outcome: the question is no longer open,
      // or cannot be evaluated. Never retry it blindly.
      return this._record({ status: "refused", reason: permitResult.reason, candidate });
    }

    const submitted = {
      ...request,
      templateParamsHash: permitResult.templateParamsHash,
      conditionHash: permitResult.permit.conditionHash,
      announceDelay: BigInt(announceDelay),
    };
    try {
      const market = await this.chain.publishSlot(submitted, permitResult.permit, permitResult.signature, restricted);
      return this._record({
        status: "published",
        market,
        slotIndex: candidate.slotIndex,
        conditionDocument,
        conditionHash: permitResult.permit.conditionHash,
        candidate,
      });
    } catch (error) {
      return this._record({ status: "failed", reason: error.message ?? String(error), candidate });
    }
  }

  pending() {
    return this.queue.filter((entry) => entry.status === "queued");
  }

  history() {
    return [...this.queue];
  }
}

/** How a metric reads in a sentence, rather than as a field name. */
const METRIC_PROSE = {
  realized_pnl_usd: "realized P&L",
  return_pct: "return",
};

/** How a comparison reads in a sentence. */
const OPERATOR_PROSE = {
  ">=": "at least",
  ">": "more than",
  "<=": "at most",
  "<": "less than",
};

/** `10000` -> `10,000`, so the published question reads like a question. */
function groupThousands(value) {
  const text = String(value ?? "");
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** A metric's value as it appears in prose, with its unit. */
function valueProse(metric, value) {
  return metric === "return_pct" ? `${groupThousands(value)}%` : `$${groupThousands(value)}`;
}

/**
 * The question text for a template and its params.
 *
 * Exists because the catalogue could SETTLE a question and could not STATE
 * one: entries carried `shape`, `winnerRewardBps` and `buildCondition`, so the
 * words were a free-text operator input that nothing reconciled against the
 * rule. See `assertQuestionMatches` for what that cost.
 */
export function renderQuestion(catalog, templateId, params) {
  const entry = catalog.get(templateId);
  if (!entry) throw new Error(`unknown template "${templateId}" — this room cannot state a question it cannot settle`);
  return entry.renderQuestion(params);
}

/**
 * Refuses a question whose words disagree with the rule that will settle it.
 *
 * `--question "Who reaches $5,000 first?" --param target=10000` published
 * cleanly and was immutable on chain. Every forecaster read a question about
 * $5,000 and traded against a rule that settled at $10,000, and no component
 * could notice because none of them had ever been told the two were supposed
 * to correspond.
 *
 * Compared against the rendered form rather than lint-checked for stray
 * numbers: a comparison against the one true rendering cannot be satisfied by
 * a question that happens to contain the right digits in the wrong claim.
 */
export function assertQuestionMatches(catalog, templateId, params, question) {
  const text = String(question ?? "").trim();
  if (!text) throw new Error("a question is required: an empty one is stored on chain exactly as written");
  const expected = renderQuestion(catalog, templateId, params);
  if (normalizeQuestion(text) !== normalizeQuestion(expected)) {
    throw new Error(
      `the question does not match the rule that settles it.\n` +
        `  asked:    ${text}\n` +
        `  settles:  ${expected}\n` +
        `Publish the rendered question, or change the params so the rule says what the question asks.`
    );
  }
  return expected;
}

/** Whitespace and case are presentation; the claim is what must agree. */
function normalizeQuestion(text) {
  return String(text).trim().replace(/\s+/g, " ").toLowerCase();
}

/** Metrics this build can actually compute — see `metricValue` in domain/conditions.mjs. */
const KNOWN_METRICS = new Set(["realized_pnl_usd", "return_pct"]);
/** Comparisons `satisfies` implements. */
const KNOWN_OPERATORS = new Set([">=", ">", "<=", "<"]);

/**
 * Refuses a parameter whose value is not one this build can act on.
 *
 * Presence-only validation was the whole defect behind issue 42: a value that
 * merely existed passed, and a mistyped participant then produced a question
 * that matched no events, scanned as `undecided`, was signed by the gate, and
 * settled NO at session end with full confidence. It paid the wrong side, and
 * every fail-closed mechanism was bypassed because nothing ever decided the
 * question was unanswerable.
 */
function oneOf(value, allowed, label) {
  if (allowed.has(value)) return value;
  throw new Error(`${label} "${value}" is not one this room can settle on — expected one of: ${[...allowed].join(", ")}`);
}

/**
 * The approved Question Template catalog for the first Competition Template.
 *
 * @param options.participants the room's roster, when the caller knows it.
 *   Given one, a question naming somebody who is not in it is refused here
 *   rather than discovered at settlement. Omitted, every check that does not
 *   need a roster still runs — a caller with no roster is not a caller with no
 *   validation.
 */
export function firstTemplateCatalog({ participants = null } = {}) {
  const roster = participants && participants.length > 0
    ? new Set(participants.map((entry) => String(entry?.key ?? entry).toLowerCase()))
    : null;
  const participantIn = (value) => {
    if (!roster) return value;
    if (roster.has(String(value).toLowerCase())) return value;
    throw new Error(
      `participant "${value}" is not in this room — expected one of: ${[...roster].join(", ")}`
    );
  };

  return new Map([
    [
      "tpl-participant-v1",
      {
        shape: "participant",
        winnerRewardBps: 100,
        renderQuestion: (params) => {
          if (!params?.target) throw new Error("target required");
          return `Who is first to reach ${valueProse("realized_pnl_usd", params.target)} in realized P&L?`;
        },
        buildCondition: (params) => {
          if (!params.target) throw new Error("target required");
          return { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: params.target } };
        },
      },
    ],
    [
      "tpl-threshold-v1",
      {
        shape: "threshold",
        winnerRewardBps: 0,
        renderQuestion: (params) => {
          for (const key of ["participant", "metric", "operator", "value"]) {
            if (!params?.[key]) throw new Error(`${key} required`);
          }
          const metric = oneOf(params.metric, KNOWN_METRICS, "metric");
          const operator = oneOf(params.operator, KNOWN_OPERATORS, "operator");
          return (
            `Will ${params.participant} finish with ${OPERATOR_PROSE[operator]} ` +
            `${valueProse(metric, params.value)} ${METRIC_PROSE[metric]}?`
          );
        },
        buildCondition: (params) => {
          for (const key of ["participant", "metric", "operator", "value"]) {
            if (!params[key]) throw new Error(`${key} required`);
          }
          return {
            condition_version: "1.0.0",
            template: "participant_metric_threshold",
            params: {
              participant: participantIn(params.participant),
              metric: oneOf(params.metric, KNOWN_METRICS, "metric"),
              operator: oneOf(params.operator, KNOWN_OPERATORS, "operator"),
              value: params.value,
            },
          };
        },
      },
    ],
    [
      "tpl-race-v1",
      {
        shape: "race",
        winnerRewardBps: 100,
        renderQuestion: (params) => {
          for (const key of ["metric", "operator", "value"]) {
            if (!params?.[key]) throw new Error(`${key} required`);
          }
          const metric = oneOf(params.metric, KNOWN_METRICS, "metric");
          const operator = oneOf(params.operator, KNOWN_OPERATORS, "operator");
          return (
            `Who is first to reach ${OPERATOR_PROSE[operator]} ` +
            `${valueProse(metric, params.value)} ${METRIC_PROSE[metric]}?`
          );
        },
        buildCondition: (params) => {
          for (const key of ["metric", "operator", "value"]) {
            if (!params[key]) throw new Error(`${key} required`);
          }
          return {
            condition_version: "1.0.0",
            template: "first_to_metric",
            params: {
              metric: oneOf(params.metric, KNOWN_METRICS, "metric"),
              operator: oneOf(params.operator, KNOWN_OPERATORS, "operator"),
              value: params.value,
            },
          };
        },
      },
    ],
  ]);
}
