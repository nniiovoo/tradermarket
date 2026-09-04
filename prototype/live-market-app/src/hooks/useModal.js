import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Makes a dialog behave like one.
 *
 * `role="dialog"` with `aria-modal="true"` is a promise to assistive
 * technology: focus is inside this thing and nothing behind it is reachable.
 * Without a trap that promise is false — Tab walks out into the page behind,
 * Escape does nothing, and closing drops focus on <body>, which for a keyboard
 * or screen-reader user means losing their place completely, mid-trade.
 *
 * Returns a ref to attach to the dialog element.
 */
export function useModal(onClose) {
  const ref = useRef(null);
  // Held in a ref so the effect can run exactly once per dialog.
  //
  // Every call site passes a fresh inline arrow, so `onClose` has a new
  // identity on every render of the shell — and the shell re-renders on the
  // 12-second wallet poll, the 15-second room poll, and every SSE frame. With
  // `onClose` as a dependency the effect tore down and re-ran each time:
  // cleanup restored focus to a stale capture, then setup pulled focus back to
  // the first field. A keyboard user was thrown out of whatever control they
  // were on every few seconds, which is the exact failure this hook exists to
  // prevent.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;

    const previouslyFocused = document.activeElement;

    const focusable = () => [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);

    // Move focus in, preferring the first real control over the close button so
    // the dialog opens where the work is.
    const items = focusable();
    const first = items.find((el) => !el.classList.contains("close-button")) ?? items[0] ?? dialog;
    first.focus?.();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;

      const list = focusable();
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = list[0];
      const lastItem = list[list.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === firstItem || !dialog.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !dialog.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Return focus to whatever opened the dialog.
      previouslyFocused?.focus?.();
    };
  }, []);

  return ref;
}
