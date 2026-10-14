import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "../src/browser";

const dir = mkdtempSync(join(tmpdir(), "hatbot-profile-"));
const running = join(dir, "running");
const cdp = Bun.serve({ port: 0, fetch: () => Response.json({ webSocketDebuggerUrl: "ws://x" }) });
process.env.HATBOT_CHROMIUM_PROFILE = running;
process.env.HATBOT_CDP = `http://127.0.0.1:${cdp.port}`;
const { useProfile } = await import("../src/profile");

/** hatbot-chromium.service, in short: Chromium closes and comes back on the profile asked for. */
const browser = {
  quits: 0,
  async quit() {
    this.quits++;
    setTimeout(() => writeFileSync(running, readFileSync(join(dir, "browser-profile"))), 50);
  },
};

test("switches Chromium to a bot's profile, and only when it's on another", async () => {
  writeFileSync(running, "hatbot\n");
  expect(await useProfile("hatbot", dir, browser as unknown as Browser)).toBe("hatbot");
  expect(browser.quits).toBe(0);
  expect(await useProfile("chef", dir, browser as unknown as Browser)).toBe("chef");
  expect(browser.quits).toBe(1);
  expect(readFileSync(running, "utf8").trim()).toBe("chef");
  await expect(useProfile("../x", dir, browser as unknown as Browser)).rejects.toThrow();
});

test("one shared profile where the service isn't set up", async () => {
  expect(await useProfile("chef", null, browser as unknown as Browser)).toBeNull();
});
