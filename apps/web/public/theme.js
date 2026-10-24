// The chosen theme and the last bot's colours before the app loads, so nothing flashes; the browser's
// bar takes amber's background (themes.css's --bg-light and --bg-dark) until the app paints it.
{
  const theme = localStorage.getItem("hatbot-theme") || "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.hue = localStorage.getItem("hatbot-hue") || "amber";
  if (theme !== "system") {
    const color = theme === "dark" ? "#120d08" : "#fff8f5";
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = color;
  }
}
