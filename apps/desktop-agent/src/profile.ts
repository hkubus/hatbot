// Each bot's own Chromium profile, so its logins and cookies stay its own. hatbot-chromium.service
// runs Chromium on the profile named in the state directory, and comes back on it when Chromium closes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_ID } from "@hatbot/shared/bot-id";
import { type Browser, BrowserError } from "./browser";

/** Written by the service as it starts Chromium: the profile it's on. */
const RUNNING = process.env.HATBOT_CHROMIUM_PROFILE ?? "/run/hatbot-chromium/profile";
const SWITCH_TIMEOUT_MS = 30_000;

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
};

/** The profile Chromium is on; null where it isn't run by hatbot-chromium.service (one shared profile). */
export const runningProfile = (path = RUNNING) => read(path);

/**
 * Switches Chromium to `id`'s profile, closing it if it's on another: its tabs go with it. Null where
 * there's only the one shared profile. `runningPath`: where the service says which one it's on;
 * `pollMs`: how long to wait between looks while Chromium comes back.
 */
export async function useProfile(
  id: string,
  stateDir: string | null,
  browser: Browser,
  runningPath = RUNNING,
  pollMs = 300,
): Promise<string | null> {
  if (!BOT_ID.test(id)) throw new BrowserError("That isn't a profile name.");
  const running = runningProfile(runningPath);
  if (!running || !stateDir) return null;
  if (running === id) return id;
  writeFileSync(join(stateDir, "browser-profile"), `${id}\n`, { mode: 0o644 });
  await browser.quit();
  const end = Date.now() + SWITCH_TIMEOUT_MS;
  while (Date.now() < end) {
    await Bun.sleep(pollMs);
    if (runningProfile(runningPath) === id && (await browser.devToolsUp(1000))) return id;
  }
  throw new BrowserError(`Chromium didn't come back on the ${id} profile.`);
}
