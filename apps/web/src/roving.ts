import { type RefObject, useEffect, useRef } from "react";

const KEYS = { x: ["ArrowLeft", "ArrowRight"], y: ["ArrowUp", "ArrowDown"] } as const;

/** Those of `selector` in `root` the focus can go to: not disabled, and on screen. */
export function focusable(root: ParentNode, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => !el.matches(":disabled") && el.getClientRects().length > 0,
  );
}

/**
 * The arrow keys along `axis`, and Home and End when `ends`, move the focus from one of `items` to
 * another, stopping at the first and last. Returns where it went, or null for a key it leaves.
 */
export function moveFocus(
  e: KeyboardEvent,
  items: HTMLElement[],
  axis: "x" | "y",
  ends = true,
): HTMLElement | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return null;
  const i = items.indexOf(e.target as HTMLElement);
  if (i < 0) return null;
  const [back, on] = KEYS[axis];
  const to =
    e.key === back
      ? i - 1
      : e.key === on
        ? i + 1
        : ends && e.key === "Home"
          ? 0
          : ends && e.key === "End"
            ? items.length - 1
            : null;
  if (to === null) return null;
  e.preventDefault();
  const next = items[Math.max(0, Math.min(items.length - 1, to))] as HTMLElement;
  next.focus();
  return next;
}

/**
 * A list Tab reaches once, on its `.active` item or else the first; the arrow keys go through the
 * rest. `onMove` hears where they went, for a choice that follows the focus.
 */
export function useRoving(
  ref: RefObject<HTMLElement | null>,
  selector: string,
  axis: "x" | "y",
  onMove?: (el: HTMLElement) => void,
) {
  const moved = useRef(onMove);
  moved.current = onMove;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Items come and go with the store, without this component rendering again.
    const mark = () => {
      const all = [...root.querySelectorAll<HTMLElement>(selector)];
      const stop = all.find((el) => el.classList.contains("active")) ?? all[0];
      for (const el of all) el.tabIndex = el === stop ? 0 : -1;
    };
    mark();
    const watch = new MutationObserver(mark);
    watch.observe(root, { subtree: true, childList: true, attributeFilter: ["class"] });
    const onKey = (e: KeyboardEvent) => {
      const to = moveFocus(e, focusable(root, selector), axis);
      if (to) moved.current?.(to);
    };
    root.addEventListener("keydown", onKey);
    return () => {
      watch.disconnect();
      root.removeEventListener("keydown", onKey);
    };
  }, [ref, selector, axis]);
}
