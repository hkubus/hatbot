import { afterAll, beforeAll, expect, test } from "bun:test";
import { Browser, ChromiumDown } from "../src/browser";
import { CONTEXT_JS, context, ELEMENT_JS, inspect, SECRET } from "../src/cdp";
import { type Chromium, serve, startChromium, withChromium } from "./chromium";

type Field = {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  label?: string;
  inputMode?: string;
  maxLength?: number;
  pattern?: string;
  tag?: string;
};
const isSecret = new Function(`${SECRET}; return isSecret;`)() as (el: unknown) => boolean;
/** An element with just what isSecret reads. */
const input = (f: Field) => ({
  tagName: f.tag ?? "INPUT",
  type: f.type ?? "text",
  id: f.id ?? "",
  inputMode: f.inputMode ?? "",
  maxLength: f.maxLength ?? -1,
  pattern: f.pattern ?? "",
  getAttribute: (a: string) =>
    ({
      autocomplete: f.autocomplete,
      name: f.name,
      placeholder: f.placeholder,
      "aria-label": f.label,
    })[a] ?? null,
});

test("Teach knows password, code and card fields, and not the fields that only look like them", () => {
  const secret: Field[] = [
    { type: "password" },
    { autocomplete: "one-time-code" },
    { autocomplete: "cc-number" },
    { name: "hasło" },
    { name: "blikCode" },
    { name: "OTPCode" },
    { name: "pin1" },
    { name: "numerKarty" },
    { label: "Verify it's you" },
    { tag: "TEXTAREA", name: "private_key" },
    // Short number fields: one box per digit, or a whole code; and a card number by its shape or length.
    { inputMode: "numeric", maxLength: 1 },
    { inputMode: "numeric", maxLength: 6 },
    { placeholder: "1234 1234 1234 1234" },
    { name: "x", inputMode: "numeric", maxLength: 19 },
  ];
  const ordinary: Field[] = [
    { name: "q" },
    { tag: "TEXTAREA", name: "message" },
    // Inputs nobody types into, whatever they're called.
    { type: "checkbox", name: "remember_password" },
    { type: "submit", name: "verify" },
    // Codes that aren't secret, words that only start like a pin or a pass, and a card that isn't one.
    { name: "promoCode" },
    { label: "Kod rabatowy" },
    { name: "kod_pocztowy" },
    { placeholder: "Verify your email" },
    { name: "ping_host" },
    { name: "passport" },
    { name: "card_title" },
    // Short numbers that say what they are: how many, a house, a phone.
    { name: "quantity", type: "number", maxLength: 3 },
    { name: "house_number", inputMode: "numeric", maxLength: 6 },
    { name: "phone", type: "tel", maxLength: 15 },
  ];
  for (const f of secret) expect([f, isSecret(input(f))]).toEqual([f, true]);
  for (const f of ordinary) expect([f, isSecret(input(f))]).toEqual([f, false]);
});

test("the page says when a secret field holds something; its scripts compile", () => {
  const page = new Function("document", "o", `return (${CONTEXT_JS})(o);`) as (
    d: unknown,
    o: unknown,
  ) => { secretShown?: boolean };
  const shown = (value: string) => {
    const field = {
      ...input({ autocomplete: "cc-number" }),
      value,
      getClientRects: () => [{}],
      ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: "visible" }) } },
    };
    return page({ querySelectorAll: () => [field], body: { innerText: "" } }, { secrets: true })
      .secretShown;
  };
  expect(shown("4111111111111111")).toBe(true);
  expect(shown("")).toBe(false);
  expect(() => new Function(`return (${ELEMENT_JS});`)).not.toThrow();
});

test("a page that can't be read when asked about secrets counts as showing one", async () => {
  const failing = (err: Error) =>
    ({
      onScreen: async () => {
        throw err;
      },
    }) as unknown as Browser;
  expect(await context(failing(new Error("Runtime.evaluate timed out")), false, true)).toEqual({
    url: null,
    title: null,
    secretShown: true,
  });
  // With Chromium not running, nothing shows.
  expect(await context(failing(new ChromiumDown("down")), false, true)).toEqual({
    url: null,
    title: null,
  });
});

const live = test.skipIf(!withChromium);
let chromium: Chromium | undefined;
let real: Browser;
beforeAll(async () => {
  if (!withChromium) return;
  chromium = await startChromium();
  real = new Browser(null, chromium.endpoint);
});
const pages: Record<string, string> = {};
const server = serve(pages);
const base = `http://127.0.0.1:${server.port}`;
afterAll(async () => {
  server.stop(true);
  await chromium?.stop();
});
Object.assign(pages, {
  "/shadow": `<!doctype html><body><div id="h"></div><script>
    document.getElementById("h").attachShadow({ mode: "open" }).innerHTML =
      "<input type=password value=hunter2>";</script></body>`,
  "/frame": `<!doctype html><body>
    <iframe srcdoc="<input name=cardnumber autocomplete=cc-number value=4242424242424242>"></iframe></body>`,
  "/stripe": `<!doctype html><body>
    <iframe src="http://localhost:${server.port}/blank" title="Secure card payment input frame"></iframe></body>`,
  "/plain": `<!doctype html><body><input name="q" value="dune">
    <iframe src="http://localhost:${server.port}/blank" title="Map"></iframe></body>`,
  // Stripe.js's controller frame, on every page that loads it: hidden, a pixel high.
  "/stripejs": `<!doctype html><body><h1>Blog post</h1>
    <iframe name="__privateStripeController1" allow="payment *" aria-hidden="true" tabindex="-1"
      src="http://localhost:${server.port}/blank?js.stripe.com"
      style="border:none;width:1px;min-width:100%;display:block;visibility:hidden;position:fixed;height:1px"></iframe></body>`,
  "/editor": `<!doctype html><body style="margin:0">
    <trix-editor contenteditable="true" style="display:block;width:200px;height:40px">hello</trix-editor></body>`,
  "/blank": "<!doctype html><body></body>",
  // A widget whose password box is in a closed shadow root, focused: the page sees only the widget.
  "/closed": `<!doctype html><body><pw-box></pw-box><script>
    customElements.define("pw-box", class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "closed" });
        root.innerHTML = "<input type=password name=password>";
        root.querySelector("input").focus();
      }
    });</script></body>`,
  // The popup is written as it opens, so it has no page to load.
  "/opener": `<!doctype html><body style="margin:0">
    <button style="width:100px;height:40px" onclick="window.open('', 'pay', 'width=400,height=300')
      .document.write('<textarea name=private_key>KEY</textarea>')">Pay</button></body>`,
});

/** Whether a secret shows on the page, once loaded: navigate waits for its frames to load too. */
async function shown(path: string): Promise<boolean | undefined> {
  await real.call("navigate", { url: `${base}${path}` });
  return (await context(real, false, true)).secretShown;
}

live("a secret shows in a shadow root, a frame, a payment frame or a popup's window", async () => {
  const expected = [
    ["/shadow", true],
    ["/frame", true],
    ["/stripe", true],
    ["/plain", false],
    ["/stripejs", false],
  ] as const;
  for (const [path, secret] of expected) expect([path, await shown(path)]).toEqual([path, secret]);
  // The popup's window shows too, though the tab under it is the active one.
  expect(await shown("/opener")).toBe(false);
  await real.call("left_click", { target: { type: "coordinate", x: 20, y: 20 } });
  expect(await context(real, false, true)).toMatchObject({
    url: `${base}/opener`,
    secretShown: true,
  });
  const popup = (await real.state()).tabs.find((t) => !t.active);
  await real.call("close_tab", { tab_id: popup?.tab_id });
});

live("typing into a closed shadow root counts as secret: its input can't be seen", async () => {
  await real.call("navigate", { url: `${base}/closed` });
  expect(await inspect(real)).toMatchObject({ tag: "pw-box", secret: true });
  // A custom element that is itself the box isn't hiding one.
  await real.call("navigate", { url: `${base}/editor` });
  await real.call("left_click", { target: { type: "coordinate", x: 20, y: 20 } });
  expect(await inspect(real)).toMatchObject({
    tag: "trix-editor",
    editable: true,
    secret: false,
  });
});
