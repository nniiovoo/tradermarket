import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchRoom, fetchRooms, roomApiConfigured, subscribeToRoom } from "./roomClient.js";
import { connectionAfterStreamStatus } from "./room-connection.js";

const ROOM_ID = import.meta.env?.VITE_ROOM_ID || "";

/**
 * Live Room state for the app.
 *
 * `mode` is the honest description of where the data came from:
 *   "live"     — snapshot plus a connected stream
 *   "polling"  — snapshot reads, no live connection
 *   "fallback" — the Coordinator is unreachable; the app is reading the
 *                market contract directly over RPC
 *
 * A lost connection is never reported as a suspended market.
 */
/**
 * @param address the connected account, when there is one.
 *
 * Passed on every read so an allowlisted reader is identified. Without it, a
 * user who had been allowlisted and had accepted the terms was refused the Live
 * Room — and only the Live Room — while every other surface worked.
 */
export function useLiveRoom(address = null) {
  const configured = roomApiConfigured() && Boolean(ROOM_ID);
  const [snapshot, setSnapshot] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [connection, setConnection] = useState(configured ? "connecting" : "unconfigured");
  const [error, setError] = useState("");
  const [deniedCopy, setDeniedCopy] = useState("");
  const unsubscribe = useRef(null);

  const refresh = useCallback(async () => {
    if (!configured) return;

    // The room and the room *list* are read independently. Coupling them with
    // Promise.all meant a failure of /v1/rooms — a list nothing on this page
    // consumes — threw away a good room snapshot and froze the displayed price.
    const [roomResult, listResult] = await Promise.allSettled([
      fetchRoom(ROOM_ID, { address: address || null }),
      fetchRooms({ address: address || null }),
    ]);

    if (listResult.status === "fulfilled") setRooms(listResult.value.rooms ?? []);

    if (roomResult.status === "fulfilled") {
      setSnapshot(roomResult.value);
      setError("");
      setDeniedCopy("");
      // Cleared on success. Only ever setting "unreachable" meant one blip made
      // the app say the API was not answering for the rest of the session,
      // while it kept rendering fresh data from that same API.
      setConnection((current) => (current === "unreachable" ? "polling" : current));
      return;
    }

    const caught = roomResult.reason;
    if (caught?.status === 403) setDeniedCopy(caught.copy || caught.message);
    else setError(caught?.message ?? "the room API did not answer");
    setConnection("unreachable");
  }, [configured, address]);

  useEffect(() => {
    if (!configured) return undefined;
    refresh();
    unsubscribe.current = subscribeToRoom(ROOM_ID, {
      address: address || null,
      onStatus: (status) => setConnection((current) => connectionAfterStreamStatus(current, status)),
      onResync: () => refresh(),
      onFrame: (frame) => {
        // Frames are deltas over a snapshot the server also serves whole.
        // Refetching on structural changes keeps one code path for state.
        if (
          frame.type.startsWith("slot.") ||
          frame.type.startsWith("room.") ||
          frame.type === "source.freshness_changed"
        ) {
          refresh();
        }
      },
    });
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      unsubscribe.current?.();
      window.clearInterval(interval);
    };
  }, [configured, refresh]);

  const mode = useMemo(() => {
    if (!configured || connection === "unreachable") return "fallback";
    if (connection === "live") return "live";
    return "polling";
  }, [configured, connection]);

  const focusSlot = useMemo(() => {
    if (!snapshot) return null;
    const index = snapshot.program?.focus;
    return snapshot.program?.slots?.find((slot) => slot.slot_index === index) ?? null;
  }, [snapshot]);

  // `/v1/rooms` carries the indexed LiveRoom contract address. Market slots
  // hold no session bond themselves, so the participant flow needs this exact
  // target for read, approval, post and eventual claim.
  const roomAddress = useMemo(
    () => rooms.find((room) => room.room_id === ROOM_ID)?.live_room_address ?? null,
    [rooms]
  );

  return {
    configured,
    snapshot,
    rooms,
    roomAddress,
    focusSlot,
    slots: snapshot?.program?.slots ?? [],
    health: snapshot?.health ?? null,
    connection,
    mode,
    error,
    deniedCopy,
    refresh,
  };
}
