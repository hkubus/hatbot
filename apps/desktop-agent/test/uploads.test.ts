import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPage } from "@hatbot/shared/desktop";
import { Browser } from "../src/browser";
import { putUpload, stagedPaths, sweepUploads, UPLOAD_TTL_MS } from "../src/uploads";
import { type Chromium, serve, startChromium, withChromium } from "./chromium";

const root = mkdtempSync(join(tmpdir(), "hatbot-uploads-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

test("files go on an input only from the task's own stage, and only on an add-listing page", async () => {
  await putUpload(root, "listing-7-olx", "1.jpg", jpeg);
  expect(stagedPaths(root, "listing-7-olx", ["1.jpg"])).toEqual([
    join(root, "listing-7-olx/1.jpg"),
  ]);
  // Another task's stage, a name that leaves it, a stage that isn't one.
  expect(() => stagedPaths(root, "listing-8-olx", ["1.jpg"])).toThrow("isn't staged");
  expect(() => stagedPaths(root, "listing-7-olx", ["../listing-7-olx/1.jpg"])).toThrow();
  expect(() => stagedPaths(root, "../etc", ["passwd"])).toThrow();
  await expect(putUpload(root, "x", "../../evil", jpeg)).rejects.toThrow();

  expect(uploadPage("https://www.olx.pl/adding/?bs=olx_pro")?.channel).toBe("OLX");
  expect(uploadPage("https://www.vinted.pl/items/new")?.channel).toBe("Vinted");
  for (const url of [
    "https://www.olx.pl/d/oferta/rtx-ID1.html",
    "https://olx.pl.evil.example/adding/",
    "http://www.olx.pl/adding/",
    "https://www.vinted.pl/items/newsletter",
  ])
    expect([url, uploadPage(url)]).toEqual([url, null]);
});

test("staged files go an hour after they were put there", async () => {
  await putUpload(root, "old", "1.jpg", jpeg);
  const then = (Date.now() - UPLOAD_TTL_MS - 60_000) / 1000;
  utimesSync(join(root, "old"), then, then);
  await putUpload(root, "fresh", "1.jpg", jpeg);
  sweepUploads(root);
  expect([existsSync(join(root, "old")), existsSync(join(root, "fresh"))]).toEqual([false, true]);
});

const live = test.skipIf(!withChromium);
let chromium: Chromium | undefined;
beforeAll(async () => {
  if (withChromium) chromium = await startChromium();
});
afterAll(() => chromium?.stop());

live("a staged file lands on a real file input hidden behind a button", async () => {
  const server = serve({
    "/adding": `<!doctype html><body><div role="button" tabindex="0">Dodaj zdjęcia
      <input type="file" accept="image/*" multiple hidden
        onchange="out.textContent = [...this.files].map((f) => f.name + ':' + f.size).join()"></div>
      <p id="out">none</p></body>`,
  });
  try {
    const browser = new Browser(null, chromium?.endpoint);
    await browser.call("navigate", { url: `http://127.0.0.1:${server.port}/adding` });
    const tree = await browser.call("read_page", {});
    const ref = /"Dodaj zdjęcia" \[(ref_\d+)\]/.exec(tree.kind === "text" ? tree.text : "")?.[1];
    expect(ref).toBeDefined();
    await putUpload(root, "listing-1-olx", "1.jpg", jpeg);
    await putUpload(root, "listing-1-olx", "2.jpg", jpeg);
    const paths = stagedPaths(root, "listing-1-olx", ["1.jpg", "2.jpg"]);
    await expect(browser.setFiles({ ref, paths }, () => false)).rejects.toThrow("add-listing");
    await browser.setFiles({ ref, paths }, () => true);
    const page = await browser.call("get_page_text", {});
    expect(page.kind === "text" && page.text).toContain("1.jpg:4,2.jpg:4");
  } finally {
    server.stop(true);
  }
});
