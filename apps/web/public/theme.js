// The chosen theme before the app loads, so nothing flashes; the browser's bar takes its colour too
// (styles.css's --bg-light and --bg-dark).
{
  const theme = localStorage.getItem("hatbot-theme") || "system";
  document.documentElement.dataset.theme = theme;
  if (theme !== "system") {
    const color = theme === "dark" ? "#170c00" : "#fff5ec";
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = color;
  }
}
