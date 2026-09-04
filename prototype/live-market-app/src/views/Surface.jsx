import { AlertTriangle, Loader2, RefreshCw, ShieldAlert, Info } from "lucide-react";

/**
 * The shared honest-state wrapper.
 *
 * Loading, unconfigured, denied, and error each get their own presentation, and
 * an error that can be retried gets a retry control. A surface never silently
 * renders an empty list when the truth is "we could not reach the server" —
 * that distinction is the difference between "no markets are live" and "we do
 * not know what is live".
 */
export function Surface({ resource, emptyWhen, empty, children, label = "content" }) {
  if (resource.status === "loading") {
    return (
      <div className="surface-state" role="status" aria-live="polite">
        <Loader2 className="spin" size={18} aria-hidden="true" />
        <span>Loading {label}…</span>
      </div>
    );
  }

  if (resource.status === "unconfigured") {
    return (
      <div className="surface-state muted" role="status">
        <Info size={18} aria-hidden="true" />
        <div>
          <strong>Not configured</strong>
          <p>{resource.error?.message}</p>
        </div>
      </div>
    );
  }

  if (resource.status === "denied") {
    return (
      <div className="surface-state warn" role="alert">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <strong>You cannot access this yet</strong>
          <p>{resource.error?.copy ?? resource.error?.message}</p>
          <a className="inline-link" href="#/enter">
            See what is required
          </a>
        </div>
      </div>
    );
  }

  if (resource.status === "error") {
    return (
      <div className="surface-state bad" role="alert">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>{resource.error?.notFound ? "Not found" : "Could not load this"}</strong>
          <p>{resource.error?.message}</p>
          {resource.error?.retryable ? (
            <button type="button" className="secondary-button" onClick={() => resource.reload()}>
              <RefreshCw size={15} aria-hidden="true" /> Try again
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (resource.status === "idle") return null;

  if (typeof emptyWhen === "function" && emptyWhen(resource.data)) {
    return (
      <div className="surface-state muted" role="status">
        <Info size={18} aria-hidden="true" />
        <div>{empty}</div>
      </div>
    );
  }

  return children(resource.data);
}
