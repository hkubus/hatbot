// The web app inside Hatbot's desktop app, which says so before the page's scripts run. The app
// holds the sign-in: these hand it back to the app, and never reach the brain.
import { navigate } from "./router";

declare global {
  interface Window {
    hatbotApp?: { platform: string; go?: (path: string) => void };
  }
}

export const inDesktopApp = !!window.hatbotApp;

export function toDesktopApp(what: "signed-out" | "sign-out" | "computer") {
  location.href = `hatbot-app://${what}`;
}

// The app opens a notification's page in the window it already has.
if (window.hatbotApp) window.hatbotApp.go = (path) => navigate(path);
