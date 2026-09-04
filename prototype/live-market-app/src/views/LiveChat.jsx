import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestSequencer } from "../hooks/useApiResource.js";
import { chatClaim } from "../chat-claim.js";
import { ArrowRight, MessageCircle, Pin, ShieldAlert } from "lucide-react";

/**
 * Real chat, or an honest explanation of why there is none.
 *
 * The previous version rendered three invented messages and an input that went
 * nowhere. This one talks to the room's chat service: it posts with a wallet
 * signature, shows the pinned rule that chat cannot change a result, and when
 * chat is not configured it says so instead of performing a conversation.
 */
export function LiveChat({ client, roomId, account, capabilities, onSign, viewers }) {
  const configured = Boolean(capabilities?.capabilities?.chat?.available);
  const reason = capabilities?.capabilities?.chat?.reason;
  const [state, setState] = useState({ status: "idle", pinned: null, messages: [] });
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef(null);
  // Polling and the reload after a post can overlap; only the newest read wins.
  const sequencer = useRef(null);
  sequencer.current ??= createRequestSequencer();

  const load = useCallback(async () => {
    if (!configured || !roomId) return;
    const token = sequencer.current.begin();
    const result = await client.get(`/v1/rooms/${encodeURIComponent(roomId)}/chat`);
    if (!sequencer.current.isCurrent(token)) return;
    if (result.ok) {
      setState({ status: "ready", pinned: result.data.pinned, messages: result.data.messages ?? [] });
    } else {
      setState((current) => ({ ...current, status: "error" }));
    }
  }, [client, roomId, configured]);

  useEffect(() => {
    load();
    if (!configured) return undefined;
    const interval = window.setInterval(load, 8000);
    return () => window.clearInterval(interval);
  }, [load, configured]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [state.messages.length]);

  const send = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !account) return;
    setPosting(true);
    setError("");
    try {
      // Chat identity is a wallet signature: it is not custody, and it is not
      // an account system. Signing proves who is speaking, nothing more.
      //
      // The signed string names its purpose, the room, the author and the
      // moment. Signing the bare text would bind none of those: the same
      // signature would post in any room, on any deployment, forever.
      const claim = chatClaim({ roomId, address: account, text, issuedAt: Date.now() });
      const signature = await onSign?.(claim);
      const result = await client.post(`/v1/rooms/${encodeURIComponent(roomId)}/chat`, {
        address: account,
        text,
        claim,
        signature,
      });
      if (result.ok) {
        setDraft("");
        load();
      } else {
        setError(result.data?.reason ?? result.error ?? "Message rejected.");
      }
    } catch (caught) {
      setError(caught?.shortMessage ?? caught?.message ?? "Could not sign the message.");
    } finally {
      setPosting(false);
    }
  };

  if (!configured) {
    return (
      <section className="chat-panel">
        <div className="section-heading compact">
          <div>
            <MessageCircle size={18} />
            <h2>Live chat</h2>
          </div>
        </div>
        <div className="surface-state muted">
          <ShieldAlert size={18} aria-hidden="true" />
          <div>
            <strong>Chat is not available here</strong>
            <p>{reason ?? "Chat is not configured for this deployment."}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="chat-panel">
      <div className="section-heading compact">
        <div>
          <MessageCircle size={18} />
          <h2>Live chat</h2>
        </div>
        {typeof viewers === "number" ? <span>{viewers} watching</span> : null}
      </div>

      {state.pinned ? (
        <p className="chat-pinned">
          <Pin size={14} aria-hidden="true" /> {state.pinned.text}
        </p>
      ) : null}

      <div className="chat-messages" ref={listRef} aria-live="polite">
        {state.messages.length === 0 ? (
          <p className="muted-note">No messages yet. Chat is commentary and never changes a result.</p>
        ) : (
          state.messages.map((message) => (
            <p key={message.id}>
              <strong>
                {message.author?.slice(0, 8)}…{message.label ? ` (${message.label})` : ""}
              </strong>
              <span>{message.text}</span>
            </p>
          ))
        )}
      </div>

      <form className="chat-input" onSubmit={send}>
        <span className="sr-only">Send a message</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={account ? "Join the live conversation" : "Connect a wallet to chat"}
          disabled={!account || posting}
          aria-label="Message"
        />
        <button type="submit" aria-label="Send message" disabled={!account || posting || !draft.trim()}>
          <ArrowRight size={16} />
        </button>
      </form>
      {error ? (
        <p className="error-note" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
