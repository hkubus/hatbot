// The chosen theme before the app loads, so nothing flashes; the browser's
// bar takes the top bar's colour too (styles.css's --bar-light and --bar-dark).
{
  const theme = localStorage.getItem("hatbot-theme") || "system";
  document.documentElement.dataset.theme = theme;
  if (theme !== "system") {
    const color = theme === "dark" ? "#12140d" : "#edefe2";
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = color;
  }
}
