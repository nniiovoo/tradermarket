import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Orders in-flight reads so only the newest one is applied.
 *
 * Navigating from one settled market to another issues two reads. If the first
 * resolves last, its data lands under the second market's URL — the app then
 * presents one market's settlement record as another's, which is the single
 * worst thing this surface could get wrong.
 */
export function createRequestSequencer() {
  let issued = 0;
  return {
    begin() {
      issued += 1;
      return issued;
    },
    isCurrent(token) {
      return token === issued;
    },
  };
}

/**
 * One resource, four honest states.
 *
 * Every surface in this app renders exactly one of: loading, unconfigured,
 * denied, error-with-retry, or data. Nothing collapses an outage or a missing
 * deployment into an empty list, because "no markets" and "we could not reach
 * the server" mean very different things to someone deciding whether to trade.
 */
export function useApiResource(client, path, { enabled = true, refreshMs = 0, deps = [] } = {}) {
  const [state, setState] = useState({ status: enabled ? "loading" : "idle", data: null, error: null });
  const sequencer = useRef(null);
  sequencer.current ??= createRequestSequencer();

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!enabled || !path) {
        setState({ status: "idle", data: null, error: null });
        return;
      }
      const token = sequencer.current.begin();
      if (!quiet) setState((current) => ({ ...current, status: current.data ? "refreshing" : "loading" }));
      const result = await client.get(path);
      if (!sequencer.current.isCurrent(token)) return;
      if (result.ok) {
        setState({ status: "ready", data: result.data, error: null });
        return;
      }
      setState({
        status: result.unconfigured ? "unconfigured" : result.denied ? "denied" : "error",
        data: null,
        error: {
          message: result.error,
          copy: result.copy ?? null,
          retryable: Boolean(result.retryable),
          notFound: Boolean(result.notFound),
          status: result.status,
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, path, enabled, ...deps]
  );

  useEffect(() => {
    load();
    if (!refreshMs || !enabled) return undefined;
    const interval = window.setInterval(() => load({ quiet: true }), refreshMs);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshMs, enabled]);

  return { ...state, reload: load };
}
