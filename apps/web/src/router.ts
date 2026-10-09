// Client-side routes: pushState plus a popstate event, read with useRoute().
import { useSyncExternalStore } from "react";

const subscribe = (l: () => void) => {
  window.addEventListener("popstate", l);
  return () => window.removeEventListener("popstate", l);
};
const snapshot = () => location.pathname + location.search;

export type Route = { path: string; params: URLSearchParams };

export function useRoute(): Route {
  const url = useSyncExternalStore(subscribe, snapshot);
  const u = new URL(url, location.origin);
  return { path: u.pathname, params: u.searchParams };
}

export function navigate(to: string, replace = false) {
  if (to !== snapshot()) history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
