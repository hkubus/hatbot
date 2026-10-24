// The chosen theme and the last bot's colour before the app loads, so nothing flashes; the browser's
// bar takes the background too (styles.css's --bg-light and --bg-dark).
{
  const theme = localStorage.getItem("hatbot-theme") || "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.hue = localStorage.getItem("hatbot-hue") || "amber";
  if (theme !== "system") {
    const color = theme === "dark" ? "#1e1e2e" : "#eff1f5";
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = color;
  }
}
