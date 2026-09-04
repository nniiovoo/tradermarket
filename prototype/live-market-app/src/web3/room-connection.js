/**
 * Merge EventSource transport status into the room's higher-level connection
 * state. A stream failure must not overwrite the stronger fact that the HTTP
 * snapshot itself is unreachable.
 */
export function connectionAfterStreamStatus(current, status) {
  if (current === "unreachable" && status !== "connected") return current;
  return status === "connected" ? "live" : "disconnected";
}
