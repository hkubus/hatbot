// The chosen theme and the last bot's colour before the app loads, so nothing flashes; the browser's
// bar takes the top bar's colour too (styles.css's --bar-light and --bar-dark).
{
  const theme = localStorage.getItem("hatbot-theme") || "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.hue = localStorage.getItem("hatbot-hue") || "amber";
  if (theme !== "system") {
    const color = theme === "dark" ? "#181825" : "#e6e9ef";
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = color;
  }
}
