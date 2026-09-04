// Room client: snapshot fetch plus a live SSE subscription with cursor resume.
//
// The Coordinator is not authoritative. If it is unreachable, the app falls
// back to reading the market contract directly over RPC — the path the app
// already had — and says so. Quotes are always computed client-side from
// cleared reserves, never taken from the API.

const DEFAULT_BASE = import.meta.env?.VITE_ROOM_API_URL || "";

export function roomApiConfigured() {
  return Boolean(DEFAULT_BASE);
}

async function getJson(path, { base = DEFAULT_BASE, address = null } = {}) {
  const headers = address ? { "x-tm-address": address } : {};
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.reason || body.error || `room api ${response.status}`);
    error.status = response.status;
    error.copy = body.copy;
    throw error;
  }
  return response.json();
}

export function fetchRooms(options) {
  return getJson("/v1/rooms", options);
}

export function fetchRoom(roomId, options) {
  return getJson(`/v1/rooms/${roomId}`, options);
}

export function fetchSettlement(market, options) {
  return getJson(`/v1/markets/${market}/settlement`, options);
}

export function fetchPortfolio(account, options) {
  return getJson(`/v1/accounts/${account}/portfolio`, options);
}

export function fetchChat(roomId, since = 0, options) {
  return getJson(`/v1/rooms/${roomId}/chat?since=${since}`, options);
}

export function fetchHealth(options) {
  return getJson("/v1/health", options);
}

/**
 * Subscribes to the room stream. Applies frames in order, detects gaps, and
 * refetches the snapshot on resync. Returns an unsubscribe function.
 */
export function subscribeToRoom(roomId, { base = DEFAULT_BASE, since = 0, address = null, onFrame, onResync, onStatus }) {
  if (!base || typeof EventSource === "undefined") return () => {};
  let cursor = since;
  let source = null;
  let closed = false;
  let retryMs = 1000;

  const connect = () => {
    if (closed) return;
    const query = new URLSearchParams({ since: String(cursor) });
    // EventSource cannot send the x-tm-address header used by ordinary reads.
    // The API accepts the same identity in the query for this one transport.
    if (address) query.set("address", address);
    source = new EventSource(`${base}/v1/rooms/${roomId}/stream?${query}`);
    source.onopen = () => {
      retryMs = 1000;
      onStatus?.("connected");
    };
    source.onmessage = (message) => {
      const frame = JSON.parse(message.data);
      if (frame.type === "hello") {
        onStatus?.("connected");
        return;
      }
      if (frame.type === "resync" || frame.type === "resync_required") {
        onResync?.(frame.snapshot ?? null);
        return;
      }
      if (typeof frame.seq === "number") {
        // A gap means the client missed frames: rebuild rather than guess.
        if (cursor !== 0 && frame.seq > cursor + 1) {
          onResync?.(null);
        }
        cursor = frame.seq;
      }
      onFrame?.(frame);
    };
    source.onerror = () => {
      onStatus?.("disconnected");
      source?.close();
      if (closed) return;
      window.setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
  };

  connect();
  return () => {
    closed = true;
    source?.close();
  };
}
