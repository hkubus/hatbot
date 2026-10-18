// What the brain's click and Enter checks see of a page (PLAN.md §6.1), in a real headless Chromium.
import { afterAll, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { inspect as inspectScreen } from "../src/cdp";
import { serve, startChromium } from "./chromium";

const chromium = await startChromium();
const live = test.skipIf(!chromium);
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
  // A chat whose box is in a shadow root, a same-origin frame's box, and a link from the seller.
  "/deep": `<!doctype html><body style="margin:0">
    <button style="${box(0)}">${icon}</button>
    <a href="/out?to=x" style="${box(1)};display:block">kliknij</a>
    <deep-box></deep-box>
    <iframe srcdoc="<textarea>Kupię za 2000 zł</textarea>" style="position:absolute;top:300px"></iframe>
    <script>
      customElements.define("deep-box", class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: "open" }).innerHTML = '<textarea>Dzień dobry</textarea>';
        }
      });
    </script>
  </body>`,
};

/** A payment widget, as a shop embeds it from another address. */
pages["/pay"] = `<!doctype html><body style="margin:0">
  <button style="position:absolute;left:10px;top:10px;width:100px;height:40px">Zapłać</button>
  <input style="position:absolute;left:150px;top:10px;width:100px;height:30px"></body>`;
const server = serve(pages);
// Another origin: on another port it's the same site, as "localhost" another site, with its own process.
const widgets = serve({ "/pay": pages["/pay"] as string });
const base = `http://127.0.0.1:${server.port}`;
const frame = (src: string, n: number) =>
  `<iframe src="${src}" style="position:absolute;left:0;top:${n * 120}px;width:300px;height:100px;border:0"></iframe>`;
pages["/shop"] = `<!doctype html><body style="margin:0">
  ${frame(`http://localhost:${widgets.port}/pay`, 0)}
  ${frame(`http://127.0.0.1:${widgets.port}/pay`, 1)}
  ${frame("/pay", 2)}
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
});

live("the screen's inspect sees the focused control the same way", async () => {
  await browser.call("navigate", { url: `${base}/controls` });
  await browser.call("left_click", { target: { type: "coordinate", ...at(3) } });
  expect(await inspectScreen(browser)).toMatchObject({ tag: "button", label: "Kup teraz" });
});

live(
  "with nothing focused, the screen's inspect still says whether the page has the keyboard",
  async () => {
    await browser.call("navigate", { url: `${base}/chat` });
    expect(await inspectScreen(browser)).toMatchObject({
      tag: "body",
      url: `${base}/chat`,
      pageFocus: expect.any(Boolean),
    });
  },
);

live("a chat box says which buttons come after it, through shadow roots", async () => {
  await browser.call("navigate", { url: `${base}/chat` });
  await browser.call("left_click", { target: { type: "coordinate", ...at(0) } });
  // The buttons after it first, then the one before it in its own row.
  expect(await browser.inspect({})).toMatchObject({
    tag: "textarea",
    editable: true,
    buttonsAfter: ["", "Wyślij", "Emoji"],
  });
  await browser.call("left_click", { target: { type: "coordinate", x: 50, y: 170 } });
  expect(await browser.inspect({})).toMatchObject({
    tag: "textarea",
    buttonsAfter: ["Odpowiedz"],
  });
});

live("a click or focus inside another origin's frame is followed in", async () => {
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
  // The same origin's frame is entered by the page script itself.
  expect(await settled({ x: 60, y: 270 }, pay)).toMatchObject({ tag: "button", label: "Zapłać" });

  // Typing in the other site's frame: the focus is followed too, and counts as secret for teach mode.
  // Whether the page has the keyboard (not the address bar) is the tab's, and still said.
  await browser.call("left_click", { target: { type: "coordinate", x: 200, y: 25 } });
  expect(await browser.inspect({})).toMatchObject({ tag: "input", editable: true });
  expect(await inspectScreen(browser)).toMatchObject({
    tag: "input",
    secret: true,
    pageFocus: expect.any(Boolean),
  });
});

live("text boxes are seen in shadow roots and frames, and links say where they go", async () => {
  await browser.call("navigate", { url: `${base}/deep` });
  const seen = (el: unknown) => ((el as { fields?: string[] } | null)?.fields?.length ?? 0) === 2;
  expect(await settled(at(0), seen)).toMatchObject({
    tag: "button",
    fields: ["Dzień dobry", "Kupię za 2000 zł"],
  });
  expect(await browser.inspect(at(1))).toMatchObject({ tag: "a", href: `${base}/out?to=x` });
});

pages["/opener"] = `<!doctype html><body style="margin:0">
  <button style="${box(0)}" onclick="window.open('/popup', 'pp', 'width=400,height=300')">PayPal</button>
  <p style="${box(4)}">harmless text</p></body>`;
pages["/popup"] =
  `<!doctype html><body style="margin:0"><button style="${box(4)}">Pay Now</button></body>`;
pages["/dialog"] = `<!doctype html><body style="margin:0">
  <div role="dialog" aria-label="Podsumowanie zamówienia" style="position:absolute;left:0;top:0;width:300px;height:200px">
    <button style="position:absolute;left:100px;top:80px;width:100px;height:40px">Zapłać 900 zł</button>
  </div></body>`;

live("a click on a ref is checked where it lands: the button in a container's middle", async () => {
  await browser.call("navigate", { url: `${base}/dialog` });
  const found = await browser.call("find", { query: "Podsumowanie zamówienia" });
  const text = found.kind === "text" ? found.text : "";
  expect(text).toContain("dialog");
  const ref = /\[(ref_\d+)\]/.exec(text)?.[1] as string;
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
  expect(state.tabs.map((t) => new URL(t.url).pathname).sort()).toEqual(["/opener", "/popup"]);
  // Both windows' tabs say they're visible. Where the windows overlap, the screen's inspect can't tell
  // which is on top, so it says so rather than answer for the one below.
  browser.screenTouched();
  await expect(inspectScreen(browser, 50, 260)).rejects.toThrow("can't tell which is on top");
  const popup = state.tabs.find((t) => t.url.endsWith("/popup"))?.tab_id;
  await browser.call("close_tab", { tab_id: popup });
  browser.screenTouched();
  expect(await inspectScreen(browser, 50, 260)).toMatchObject({ url: `${base}/opener` });
});

const nest = (inner: string, n: number): string => (n ? `<div>${nest(inner, n - 1)}</div>` : inner);
pages["/search"] = `<!doctype html><body style="margin:0">
  <div><input placeholder="Szukaj" style="${box(0)}"><button style="${box(1)}">${icon}</button></div>
  <textarea style="${box(3)}"></textarea></body>`;
pages["/one-form"] = `<!doctype html><body style="margin:0"><form method="post">
  <input type="search" name="q" style="${box(0)}"><button style="${box(1)}">Usuń konto</button>
  <button style="${box(2)}">${icon}</button></form></body>`;
pages["/divs"] = `<!doctype html><body style="margin:0">
  <div style="${box(0)};cursor:pointer">${icon}</div>
  <div style="${box(1)};cursor:pointer"><svg width="30" height="30"><rect width="30" height="30"/></svg> Kup teraz</div></body>`;
pages["/composers"] = `<!doctype html><body style="margin:0">
  ${nest(`<textarea style="${box(0)}"></textarea>`, 7)}<button style="${box(1)}">Send</button>
  <div style="position:absolute;top:120px"><button aria-label="Wyślij" style="position:absolute;left:120px;width:40px;height:40px">${icon}</button>
    <textarea style="position:absolute;left:0;width:100px;height:40px"></textarea></div>
  <div style="position:absolute;top:200px"><div><div role="textbox" contenteditable="true" style="width:100px;height:40px"></div></div></div>
  </body>`;

live(
  "a site's search box is searching by its own name, and its query isn't a message",
  async () => {
    await browser.call("navigate", { url: `${base}/search` });
    await browser.call("left_click", { target: { type: "coordinate", ...at(0) } });
    await browser.call("type", { text: "rtx 3070" });
    expect(await browser.inspect({})).toMatchObject({ tag: "input", search: true });
    expect(await browser.inspect(at(1))).toMatchObject({ tag: "button", search: true });
    // A box elsewhere on the page doesn't count the query as text waiting to go.
    expect(await browser.inspect(at(3))).toMatchObject({ tag: "textarea", fields: [] });
    // In a page built as one form, a search box in it doesn't make its other buttons searching.
    await browser.call("navigate", { url: `${base}/one-form` });
    expect(await browser.inspect(at(1))).toMatchObject({ label: "Usuń konto", search: false });
    expect(await browser.inspect(at(2))).toMatchObject({ label: "", search: false });
  },
);

live("a div made clickable is reported as one, named by its text", async () => {
  await browser.call("navigate", { url: `${base}/divs` });
  expect(await browser.inspect(at(0))).toMatchObject({ tag: "div", role: "clickable", label: "" });
  expect(await browser.inspect({ x: 10, y: 65 })).toMatchObject({
    tag: "div",
    role: "clickable",
    label: "Kup teraz",
  });
});

live(
  "a chat box finds its Send however deep, before or after it, or says there's none",
  async () => {
    await browser.call("navigate", { url: `${base}/composers` });
    await browser.call("left_click", { target: { type: "coordinate", ...at(0) } });
    expect(await browser.inspect({})).toMatchObject({
      tag: "textarea",
      buttonsAfter: ["Send", "Wyślij"],
    });
    await browser.call("left_click", { target: { type: "coordinate", x: 50, y: 140 } });
    expect(await browser.inspect({})).toMatchObject({ tag: "textarea", buttonsAfter: ["Wyślij"] });
    await browser.call("left_click", { target: { type: "coordinate", x: 50, y: 220 } });
    expect(await browser.inspect({})).toMatchObject({ role: "textbox", buttonsAfter: [] });
  },
);

live("navigate takes its address only as text", async () => {
  await expect(browser.call("navigate", { url: [`${base}/controls`] })).rejects.toThrow(
    "url must be a string",
  );
});
