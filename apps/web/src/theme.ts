import type { BotColor } from "@hatbot/shared";
import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const getTheme = (): Theme => (localStorage.getItem("hatbot-theme") as Theme | null) ?? "system";

const bg = (dark: boolean) =>
  getComputedStyle(document.documentElement)
    .getPropertyValue(dark ? "--bar-dark" : "--bar-light")
    .trim();

/** The top bar's colour in a theme: styles.css's --chrome. */
export const barColor = (t: Theme, media: string): string =>
  bg(t === "system" ? media.includes("dark") : t === "dark");

export function setTheme(t: Theme) {
  localStorage.setItem("hatbot-theme", t);
  document.documentElement.dataset.theme = t;
  // The browser's bar (and the phone's status bar) follows a chosen theme, not only the system's.
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    m.content = barColor(t, m.media);
  window.dispatchEvent(new Event("hatbot:theme"));
}

/** The colour of the bot the app last followed: styles.css's --hue. */
export const savedHue = (): BotColor =>
  (localStorage.getItem("hatbot-hue") as BotColor | null) ?? "amber";

export function setHue(color: BotColor) {
  localStorage.setItem("hatbot-hue", color);
  document.documentElement.dataset.hue = color;
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    window.addEventListener("hatbot:theme", l);
    return () => window.removeEventListener("hatbot:theme", l);
  }, getTheme);
}
