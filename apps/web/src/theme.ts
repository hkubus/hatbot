export type Theme = "system" | "light" | "dark";

export const getTheme = (): Theme =>
  (localStorage.getItem("hatbot-theme") as Theme | null) ?? "system";

export function setTheme(t: Theme) {
  localStorage.setItem("hatbot-theme", t);
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new Event("hatbot:theme"));
}
