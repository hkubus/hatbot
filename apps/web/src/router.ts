import { useSyncExternalStore } from "react";

const subscribe = (l: () => void) => {
  window.addEventListener("popstate", l);
  return () => window.removeEventListener("popstate", l);
};
const snapshot = () => location.pathname + location.search;

/** Asked before leaving the page that set it, e.g. an editor with unsaved changes: true to go. */
let leaveGuard: (() => Promise<boolean>) | null = null;
export function setLeaveGuard(guard: () => Promise<boolean>) {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}
let shown = snapshot();
let ours = false;
let passing = false;
// Back and Forward have already moved the address when we hear of them: put it back while the page
// asks. Registered before anything renders, so it runs before the routes read the address.
window.addEventListener("popstate", (e) => {
  if (ours) return;
  if (leaveGuard && !passing) {
    e.stopImmediatePropagation();
    history.pushState(null, "", shown);
    // The entry just before the one pushed is where Back or Forward went.
    void leaveGuard().then((go) => {
      if (!go) return;
      passing = true;
      history.back();
    });
    return;
  }
  passing = false;
  shown = snapshot();
});

export type Route = { path: string; params: URLSearchParams };

export function useRoute(): Route {
  const url = useSyncExternalStore(subscribe, snapshot);
  const u = new URL(url, location.origin);
  return { path: u.pathname, params: u.searchParams };
}

export function navigate(to: string, replace = false) {
  if (to !== snapshot() && leaveGuard) {
    void leaveGuard().then((go) => go && move(to, replace));
    return;
  }
  move(to, replace);
}

function move(to: string, replace: boolean) {
  if (to !== snapshot()) history[replace ? "replaceState" : "pushState"](null, "", to);
  shown = snapshot();
  ours = true;
  try {
    window.dispatchEvent(new PopStateEvent("popstate"));
  } finally {
    ours = false;
  }
}
