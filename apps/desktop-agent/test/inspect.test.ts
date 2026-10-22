// What the brain's click and Enter checks see of a page, in a real headless Chromium.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { inspect as inspectScreen } from "../src/cdp";
import { type Chromium, serve, startChromium, withChromium } from "./chromium";

const live = test.skipIf(!withChromium);
let chromium: Chromium | undefined;
let browser: Browser;
beforeAll(async () => {
  if (!withChromium) return;
  chromium = await startChromium();
  browser = new Browser(null, chromium.endpoint);
});

/** Each control in its own 100×40 box down the left edge, so a test can point at the nth one. */
const at = (n: number) => ({ x: 50, y: n * 50 + 20 });
const box = (n: number) =>
  `position:absolute;left:0;top:${n * 50}px;width:100px;height:40px;margin:0`;
const icon = '<svg width="16" height="16"><rect width="16" height="16"/></svg>';

const pages: Record<string, string> = {
  "/controls": `<!doctype html><body style="margin:0">
    <button style="${box(0)}"><svg width="16" height="16"><title>Wyślij</title><rect width="16" height="16"/></svg></button>
    <button style="${box(1)}">${icon}</button>
    <button style="${box(2)}" aria-expanded="false">${icon}</button>
    <button style="${box(3)}" value="1">Kup teraz</button>
    <form method="get" style="${box(4)}"><input type="search" name="q" style="width:50px"><button style="width:40px">${icon}</button></form>
    <span id="l" hidden>Zapłać</span><div role="button" aria-labelledby="l" style="${box(5)}">${icon}</div>
  </body>`,
  "/chat": `<!doctype html><body style="margin:0">
    <div><div><button aria-label="Emoji">😀</button><textarea id="m" style="${box(0)}"></textarea></div>
      <button style="${box(1)}">${icon}</button><button style="${box(2)}">Wyślij</button></div>
  </body>`,
  /** A payment widget, as a shop embeds it from another address. */
  "/pay": `<!doctype html><body style="margin:0">
    <button style="position:absolute;left:10px;top:10px;width:100px;height:40px">Zapłać</button>
    <input style="position:absolute;left:150px;top:10px;width:100px;height:30px"></body>`,
  "/opener": `<!doctype html><body style="margin:0">
    <button style="${box(0)}" onclick="window.open('/popup', 'pp', 'width=400,height=300')">PayPal</button>
    <p style="${box(4)}">harmless text</p></body>`,
  "/popup": `<!doctype html><body style="margin:0"><button style="${box(4)}">Pay Now</button></body>`,
  "/dialog": `<!doctype html><body style="margin:0">
    <div role="dialog" aria-label="Podsumowanie zamówienia" style="position:absolute;left:0;top:0;width:300px;height:200px">
      <button style="position:absolute;left:100px;top:80px;width:100px;height:40px">Zapłać 900 zł</button>
    </div></body>`,
};
const server = serve(pages);
// Another origin: on another port it's the same site, as "localhost" another site, with its own process.
const widgets = serve({ "/pay": pages["/pay"] as string });
const base = `http://127.0.0.1:${server.port}`;
const frame = (src: string, n: number) =>
  `<iframe src="${src}" style="position:absolute;left:0;top:${n * 120}px;width:300px;height:100px;border:0"></iframe>`;
pages["/shop"] = `<!doctype html><body style="margin:0">
  ${frame(`http://localhost:${widgets.port}/pay`, 0)}
  ${frame(`http://127.0.0.1:${widgets.port}/pay`, 1)}
</body>`;
afterAll(async () => {
  server.stop(true);
  widgets.stop(true);
  await chromium?.stop();
});

/** Inspects until `ready` holds: frames load after their page. */
async function settled(o: Parameters<Browser["inspect"]>[0], ready: (el: unknown) => boolean) {
  for (let i = 0; ; i++) {
    const el = await browser.inspect(o);
    if (ready(el) || i === 50) return el;
    await Bun.sleep(100);
  }
}

live("icon buttons are named from their icon, and toggles and search say so", async () => {
  await browser.call("navigate", { url: `${base}/controls` });
  expect(await browser.inspect(at(0))).toMatchObject({ tag: "button", label: "Wyślij" });
  expect(await browser.inspect(at(1))).toMatchObject({ tag: "button", label: "", toggle: false });
  expect(await browser.inspect(at(2))).toMatchObject({ label: "", toggle: true });
  // A button's value isn't its name.
  expect(await browser.inspect(at(3))).toMatchObject({ label: "Kup teraz" });
  expect(await browser.inspect({ x: 80, y: 220 })).toMatchObject({ inForm: true, search: true });
  expect(await browser.inspect(at(5))).toMatchObject({ role: "button", label: "Zapłać" });
});

live("what's typed in a chat box is seen, with the buttons that would send it", async () => {
  await browser.call("navigate", { url: `${base}/chat` });
  await browser.call("left_click", { target: { type: "coordinate", ...at(0) } });
  await browser.call("type", { text: "Hej" });
  // The buttons after it first, then the one before it in its own row.
  expect(await browser.inspect({})).toMatchObject({
    tag: "textarea",
    editable: true,
    buttonsAfter: ["", "Wyślij", "Emoji"],
  });
  expect(await inspectScreen(browser)).toMatchObject({ tag: "textarea", editable: true });
  expect(await browser.inspect(at(2))).toMatchObject({ label: "Wyślij", fields: ["Hej"] });
});

live(
  "a click inside another origin's frame is followed in, and typing there is secret",
  async () => {
    await browser.call("navigate", { url: `${base}/shop` });
    const pay = (el: unknown) => (el as { label?: string } | null)?.label === "Zapłać";
    const sites = [
      [30, `http://localhost:${widgets.port}/pay`],
      [150, `http://127.0.0.1:${widgets.port}/pay`],
    ] as const;
    for (const [y, frameUrl] of sites)
      expect(await settled({ x: 60, y }, pay)).toMatchObject({
        tag: "button",
        label: "Zapłać",
        url: `${base}/shop`,
        frameUrl,
      });
    // Teach can't see the field, so typing there counts as secret. Whether the page has the keyboard (not
    // the address bar) is the tab's, and still said.
    await browser.call("left_click", { target: { type: "coordinate", x: 200, y: 25 } });
    expect(await inspectScreen(browser)).toMatchObject({
      tag: "input",
      secret: true,
      pageFocus: expect.any(Boolean),
    });
  },
);

live("a click on a ref is checked where it lands: the button in a container's middle", async () => {
  await browser.call("navigate", { url: `${base}/dialog` });
  const found = await browser.call("find", { query: "Podsumowanie zamówienia" });
  const ref = /\[(ref_\d+)\]/.exec(found.kind === "text" ? found.text : "")?.[1] as string;
  expect(await browser.inspect({ ref })).toMatchObject({ tag: "button", label: "Zapłać 900 zł" });
});

live("a popup window's point isn't checked against the page under it", async () => {
  await browser.call("navigate", { url: `${base}/opener` });
  await browser.call("left_click", { target: { type: "coordinate", ...at(0) } });
  let state = await browser.state();
  for (let i = 0; state.tabs.length < 2 && i < 50; i++) {
    await Bun.sleep(100);
    state = await browser.state();
  }
  // Both windows' tabs say they're visible. Where the windows overlap, the screen's inspect can't tell
  // which is on top, so it says so rather than answer for the one below.
  browser.screenTouched();
  await expect(inspectScreen(browser, 50, 260)).rejects.toThrow("can't tell which is on top");
  const popup = state.tabs.find((t) => t.url.endsWith("/popup"))?.tab_id;
  await browser.call("close_tab", { tab_id: popup });
  browser.screenTouched();
  expect(await inspectScreen(browser, 50, 260)).toMatchObject({ url: `${base}/opener` });
});
