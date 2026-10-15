// Client-side routes: pushState plus a popstate event, read with useRoute().
import { useSyncExternalStore } from "react";

const subscribe = (l: () => void) => {
  window.addEventListener("popstate", l);
  return () => window.removeEventListener("popstate", l);
};
const snapshot = () => location.pathname + location.search;

/** Asked before leaving the page that set it, e.g. an editor with unsaved changes: true to go. */
let leaveGuard: (() => boolean) | null = null;
export function setLeaveGuard(guard: () => boolean) {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}
let shown = snapshot();
let ours = false;
// Back and Forward have already moved the address when we hear of them: put it back if the page says
// stay. Registered before anything renders, so it runs before the routes read the address.
window.addEventListener("popstate", (e) => {
  if (ours) return;
  if (leaveGuard && !leaveGuard()) {
    e.stopImmediatePropagation();
    history.pushState(null, "", shown);
    return;
  }
  shown = snapshot();
});

export type Route = { path: string; params: URLSearchParams };

export function useRoute(): Route {
  const url = useSyncExternalStore(subscribe, snapshot);
  const u = new URL(url, location.origin);
  return { path: u.pathname, params: u.searchParams };
}

export function navigate(to: string, replace = false) {
  if (to !== snapshot() && leaveGuard && !leaveGuard()) return;
  if (to !== snapshot()) history[replace ? "replaceState" : "pushState"](null, "", to);
  shown = snapshot();
  ours = true;
  try {
    window.dispatchEvent(new PopStateEvent("popstate"));
  } finally {
    ours = false;
  }
}
