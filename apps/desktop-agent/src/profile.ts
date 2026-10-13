// Each bot's own Chromium profile (PLAN.md §14): its logins and cookies stay its own. hatbot-chromium.service
// runs Chromium on the profile named in the state directory, and comes back on it when Chromium closes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, BrowserError } from "./browser";

/** A bot's id, which names its profile. */
const PROFILE = /^[a-z][a-z0-9-]{0,30}$/;
/** Written by the service as it starts Chromium: the profile it's on. */
const RUNNING = process.env.HATBOT_CHROMIUM_PROFILE ?? "/run/hatbot-chromium/profile";
const CDP = process.env.HATBOT_CDP ?? "http://127.0.0.1:9222";
const SWITCH_TIMEOUT_MS = 30_000;

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
};

/** The profile Chromium is on; null where it isn't run by hatbot-chromium.service (one shared profile). */
export const runningProfile = () => read(RUNNING);

/**
 * Switches Chromium to `id`'s profile, closing it if it's on another: its tabs go with it. Null where
 * there's only the one shared profile.
 */
export async function useProfile(
  id: string,
  stateDir: string | null,
  browser: Browser,
): Promise<string | null> {
  if (!PROFILE.test(id)) throw new BrowserError("That isn't a profile name.");
  const running = runningProfile();
  if (!running || !stateDir) return null;
  if (running === id) return id;
  writeFileSync(join(stateDir, "browser-profile"), `${id}\n`, { mode: 0o644 });
  await browser.quit();
  const end = Date.now() + SWITCH_TIMEOUT_MS;
  while (Date.now() < end) {
    await Bun.sleep(300);
    if (runningProfile() !== id) continue;
    const up = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return id;
  }
  throw new BrowserError(`Chromium didn't come back on the ${id} profile.`);
}
