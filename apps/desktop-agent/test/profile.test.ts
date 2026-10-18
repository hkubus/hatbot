import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "../src/browser";
import { useProfile } from "../src/profile";

const dir = mkdtempSync(join(tmpdir(), "hatbot-profile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const running = join(dir, "running");

/** hatbot-chromium.service, in short: Chromium closes and comes back on the profile asked for. */
const fake = {
  quits: 0,
  async quit() {
    this.quits++;
    writeFileSync(running, readFileSync(join(dir, "browser-profile")));
  },
  devToolsUp: async () => true,
};
const browser = fake as unknown as Browser;

test("switches Chromium to a bot's profile, only when it's on another, and only by a plain name", async () => {
  writeFileSync(running, "hatbot\n");
  expect(await useProfile("hatbot", dir, browser, running)).toBe("hatbot");
  expect(fake.quits).toBe(0);
  expect(await useProfile("chef", dir, browser, running, 0)).toBe("chef");
  expect(fake.quits).toBe(1);
  expect(readFileSync(running, "utf8").trim()).toBe("chef");
  await expect(useProfile("../x", dir, browser, running)).rejects.toThrow();
});
