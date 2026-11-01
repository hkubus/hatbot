import { afterAll, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { type Chromium, startChromium, withChromium } from "./chromium";

let chromium: Chromium | undefined;
afterAll(async () => {
  await chromium?.stop();
});

test.skipIf(!withChromium)(
  "tabs that come and go, and a dropped answer, leave nothing behind",
  async () => {
    chromium = await startChromium();
    const browser = new Browser(null, chromium.endpoint);
    const keep: string[] = [];
    for (let i = 0; i < 8; i++)
      keep.push(((await browser.call("new_tab", {})) as { tab: { tab_id: string } }).tab.tab_id);
    // The tabs the browser knows a name for: the one it opened with, and these.
    expect(browser.knownTabs().length).toBe(9);
    await browser.reset();
    expect(browser.knownTabs().length).toBeLessThanOrEqual(2);

    // A world made just before the command answers in a frame the tree was already read in.
    const tab = await browser.onScreen<{ width: number }>("() => ({ width: innerWidth })");
    expect(tab?.value?.width).toBeGreaterThan(0);
  },
);
