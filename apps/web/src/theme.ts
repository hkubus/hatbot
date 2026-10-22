import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const getTheme = (): Theme => (localStorage.getItem("hatbot-theme") as Theme | null) ?? "system";

/** The page's background in each theme (--bg), as in index.html's theme-color tags and theme.js. */
const BAR = { light: "#f5f5f7", dark: "#161617" } as const;

export const barColor = (t: Theme, media: string): string =>
  t === "system" ? (media.includes("dark") ? BAR.dark : BAR.light) : BAR[t];

export function setTheme(t: Theme) {
  localStorage.setItem("hatbot-theme", t);
  document.documentElement.dataset.theme = t;
  // The browser's bar (and the phone's status bar) follows a chosen theme, not only the system's.
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    m.content = barColor(t, m.media);
  window.dispatchEvent(new Event("hatbot:theme"));
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    window.addEventListener("hatbot:theme", l);
    return () => window.removeEventListener("hatbot:theme", l);
  }, getTheme);
}
