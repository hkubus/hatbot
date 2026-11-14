// A page the iOS app shows in its own web view, under its own bar, opened with ?embedded: an installed
// plugin's page. The web app's rail, toolbar and tab bar stay hidden, as does the page's back button.
const KEY = "hatbot:embedded";

if (new URLSearchParams(location.search).has("embedded")) sessionStorage.setItem(KEY, "1");

export const embedded = sessionStorage.getItem(KEY) === "1";

if (embedded) document.documentElement.classList.add("embedded");
