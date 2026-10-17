// What the brain's click and Enter checks see of a page (PLAN.md §6.1), in a real headless Chromium.
import { afterAll, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { inspect as inspectScreen } from "../src/cdp";
import { startChromium } from "./chromium";

const chromium = await startChromium();
if (!chromium) console.log("No Chromium that runs here: the inspect tests are skipped.");
const browser = new Browser(null, chromium?.endpoint);

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
    <button style="${box(6)}">➤</button>
    <label style="${box(7)}"><input type="radio" name="d"> Paczkomat</label>
  </body>`,
  "/chat": `<!doctype html><body style="margin:0">
    <div><div><button aria-label="Emoji">😀</button><textarea id="m" style="${box(0)}"></textarea></div>
      <button style="${box(1)}">${icon}</button><button style="${box(2)}">Wyślij</button></div>
    <chat-box style="${box(3)};height:100px"></chat-box>
    <script>
      customElements.define("chat-box", class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML =
            '<textarea style="width:100px;height:40px"></textarea><button>Odpowiedz</button>';
        }
      });
    </script>
  </body>`,
};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const body = pages[new URL(req.url).pathname];
    if (!body) return new Response("no", { status: 404 });
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  chromium?.stop();
});

test.skipIf(!chromium)(
  "icon buttons are named from their icon, and toggles and search say so",
  async () => {
    await browser.call("navigate", { url: `${base}/controls` });
    expect(await browser.inspect(at(0))).toMatchObject({ tag: "button", label: "Wyślij" });
    expect(await browser.inspect(at(1))).toMatchObject({ tag: "button", label: "", toggle: false });
    expect(await browser.inspect(at(2))).toMatchObject({ label: "", toggle: true });
    // A button's value isn't its name.
    expect(await browser.inspect(at(3))).toMatchObject({ label: "Kup teraz" });
    expect(await browser.inspect({ x: 80, y: 220 })).toMatchObject({
      tag: "button",
      label: "",
      inForm: true,
      search: true,
    });
    expect(await browser.inspect(at(5))).toMatchObject({ role: "button", label: "Zapłać" });
    expect(await browser.inspect(at(6))).toMatchObject({ label: "➤" });
    // A choice's label chooses, like the choice.
    expect(await browser.inspect({ x: 80, y: 370 })).toMatchObject({
      tag: "label",
      label: "Paczkomat",
      toggle: true,
    });
  },
);

test.skipIf(!chromium)("the screen's inspect sees the focused control the same way", async () => {
  await browser.call("navigate", { url: `${base}/controls` });
  await browser.call("left_click", { target: { type: "coordinate", ...at(3) } });
  expect(await inspectScreen(browser)).toMatchObject({ tag: "button", label: "Kup teraz" });
});

test.skipIf(!chromium)(
  "a chat box says which buttons come after it, through shadow roots",
  async () => {
    await browser.call("navigate", { url: `${base}/chat` });
    await browser.call("left_click", { target: { type: "coordinate", ...at(0) } });
    expect(await browser.inspect({})).toMatchObject({
      tag: "textarea",
      editable: true,
      buttonsAfter: ["", "Wyślij"],
    });
    await browser.call("left_click", { target: { type: "coordinate", x: 50, y: 170 } });
    expect(await browser.inspect({})).toMatchObject({
      tag: "textarea",
      buttonsAfter: ["Odpowiedz"],
    });
  },
);
