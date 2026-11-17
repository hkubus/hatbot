import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { type Chromium, serve, startChromium, withChromium } from "./chromium";

const live = test.skipIf(!withChromium);
let chromium: Chromium | undefined;
let browser: Browser;
const pages: Record<string, string> = {};
const server = serve(pages);
const base = `http://127.0.0.1:${server.port}`;
beforeAll(async () => {
  if (!withChromium) return;
  chromium = await startChromium();
  browser = new Browser(null, chromium.endpoint);
});
afterAll(async () => {
  server.stop(true);
  await chromium?.stop();
});

const read = async (name: string, input: Record<string, unknown>) => {
  const r = await browser.call(name, input);
  return r.kind === "text" ? r.text : "";
};

live("a long page is read 20,000 characters at a time, saying how to read the rest", async () => {
  const offers = Array.from(
    { length: 1000 },
    (_, i) => `<p>Offer ${i}: a used bike in good condition, collected in person.</p>`,
  );
  pages["/long"] = `<!doctype html><body><main>${offers.join("")}</main></body>`;
  await browser.call("navigate", { url: `${base}/long` });
  for (const text of [
    await read("get_page_text", {}),
    await read("read_page", { filter: "all" }),
  ]) {
    const [kept, cut] = text.split("\n[Cut at ");
    expect(kept?.length).toBeGreaterThan(19_000);
    expect(kept?.length).toBeLessThanOrEqual(20_000);
    expect(kept).toContain("Offer 0:");
    expect(cut).toMatch(/^20000 characters\. \S.*\]$/);
  }
});

live("wait ends once the page is quiet, and not while a request is in flight", async () => {
  let release = () => {};
  const slow = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Promise<Response>((answer) => {
        release = () => answer(new Response("ok"));
      }),
  });
  const timed = async (duration: number) => {
    const start = Date.now();
    await browser.call("wait", { duration });
    return Date.now() - start;
  };
  try {
    pages["/quiet"] = "<!doctype html><body>Nothing more to load.</body>";
    await browser.call("navigate", { url: `${base}/quiet` });
    expect(await timed(5)).toBeLessThan(2000);

    pages["/busy"] = `<!doctype html><body><script>
      fetch("http://127.0.0.1:${slow.port}/", { mode: "no-cors" });</script></body>`;
    await browser.call("navigate", { url: `${base}/busy` });
    expect(await timed(1)).toBeGreaterThanOrEqual(1000);
    release();
    expect(await timed(5)).toBeLessThan(2000);
  } finally {
    release();
    slow.stop(true);
  }
});
