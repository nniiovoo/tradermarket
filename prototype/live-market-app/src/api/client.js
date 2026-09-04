// The website's API client.
//
// Every call resolves to a result rather than throwing, because every consumer
// surface has to render one of four honest states: data, "not configured",
// "you are not allowed and here is why", or "this failed and you can retry".
// Collapsing those into a generic error is how an interface ends up implying
// that an outage is an empty market.

export class ApiError extends Error {}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * @param options.baseUrl     API origin. Empty means this deployment has no API.
 * @param options.getAddress  optional () => address, sent as x-tm-address
 * @param options.fetchImpl   injectable for tests
 */
export function createApiClient({ baseUrl = "", getAddress = () => null, fetchImpl = null } = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  const configured = Boolean(baseUrl);

  async function request(path, { method = "GET", body = null, rawBody = null, extraHeaders = {} } = {}) {
    if (!configured) {
      return {
        ok: false,
        unconfigured: true,
        retryable: false,
        status: 0,
        data: null,
        error: "The room API is not configured for this deployment.",
      };
    }
    if (!doFetch) {
      return { ok: false, retryable: false, status: 0, data: null, error: "no fetch implementation available" };
    }

    const address = getAddress();
    const headers = { ...extraHeaders, ...(address ? { "x-tm-address": address } : {}) };
    if (body !== null) headers["content-type"] = "application/json";

    let response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== null ? { body: JSON.stringify(body) } : rawBody !== null ? { body: rawBody } : {}),
      });
    } catch (error) {
      // An unreachable API is an outage, not an empty result.
      return {
        ok: false,
        retryable: true,
        status: 0,
        data: null,
        error: `The room API is unreachable (${error.message}).`,
      };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) return { ok: true, status: response.status, data, retryable: false };

    return {
      ok: false,
      status: response.status,
      data,
      denied: response.status === 403,
      notFound: response.status === 404,
      retryable: RETRYABLE_STATUS.has(response.status),
      copy: data?.copy ?? null,
      error: data?.reason ?? data?.error ?? `Request failed (${response.status}).`,
    };
  }

  return {
    configured,
    baseUrl,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: "POST", body }),
    uploadLivestreamProof: (metadata, clip, operatorToken) => {
      const params = new URLSearchParams({
        market: String(metadata?.market ?? ""),
        outcome: String(metadata?.outcome ?? ""),
        source_sequence: String(metadata?.sourceSequence ?? ""),
        stream_url: String(metadata?.streamUrl ?? ""),
        occurred_at: String(metadata?.occurredAt ?? ""),
        clip_start_ms: String(metadata?.clipStartMs ?? ""),
        clip_end_ms: String(metadata?.clipEndMs ?? ""),
        rule: String(metadata?.rule ?? ""),
        rationale: String(metadata?.rationale ?? ""),
      });
      return request(`/v1/oracle/proofs?${params}`, {
        method: "POST",
        rawBody: clip,
        extraHeaders: {
          "content-type": "video/mp4",
          "x-tm-oracle-token": String(operatorToken ?? ""),
        },
      });
    },
  };
}
