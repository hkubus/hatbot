import type { BotColor } from "@hatbot/shared";
import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";

const getTheme = (): Theme => (localStorage.getItem("hatbot-theme") as Theme | null) ?? "system";

const bg = (dark: boolean) =>
  getComputedStyle(document.documentElement)
    .getPropertyValue(dark ? "--bg-dark" : "--bg-light")
    .trim();

/** The page's background in a theme: styles.css's --bg. */
export const barColor = (t: Theme, media: string): string =>
  bg(t === "system" ? media.includes("dark") : t === "dark");

// The browser's bar (and the phone's status bar) follows a chosen theme, not only the system's.
const paintBar = () => {
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    m.content = barColor(getTheme(), m.media);
};

export function setTheme(t: Theme) {
  localStorage.setItem("hatbot-theme", t);
  document.documentElement.dataset.theme = t;
  paintBar();
  window.dispatchEvent(new Event("hatbot:theme"));
}

/** The bot colour the app last wore: themes.css's scheme for it. */
export const savedHue = (): BotColor =>
  (localStorage.getItem("hatbot-hue") as BotColor | null) ?? "amber";

export function setHue(color: BotColor) {
  localStorage.setItem("hatbot-hue", color);
  document.documentElement.dataset.hue = color;
  paintBar();
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    window.addEventListener("hatbot:theme", l);
    return () => window.removeEventListener("hatbot:theme", l);
  }, getTheme);
}
