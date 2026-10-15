import { useSyncExternalStore } from "react";

/** Whether a media query matches, following it as it changes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = matchMedia(query);
      m.addEventListener("change", l);
      return () => m.removeEventListener("change", l);
    },
    () => matchMedia(query).matches,
  );
}

/** A touch screen with no hover: a phone or tablet. */
export const touchScreen = () => matchMedia("(hover: none)").matches;
