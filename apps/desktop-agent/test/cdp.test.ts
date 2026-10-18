import { afterAll, expect, test } from "bun:test";
import { Browser, ChromiumDown } from "../src/browser";
import { CONTEXT_JS, context, ELEMENT_JS, inspect, SECRET } from "../src/cdp";
import { serve, startChromium } from "./chromium";

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

test("Teach knows password, code and card fields by their names, in English and Polish", () => {
  for (const f of [
    { type: "password" },
    { name: "haslo" },
    { name: "hasło" },
    { id: "HasloUzytkownika" },
    { name: "blikCode" },
    { name: "smsCode" },
    { name: "SMSCode" },
    { id: "kodSms" },
    { name: "kod_blik" },
    { placeholder: "Kod BLIK" },
    { label: "Wpisz kod z SMS" },
    { name: "verificationCode" },
    { name: "verify" },
    { name: "totp" },
    { name: "mfa_token" },
    { name: "2fa" },
    { name: "pin" },
    { name: "pinCode" },
    { name: "PIN" },
    { autocomplete: "one-time-code" },
    { autocomplete: "cc-number" },
    { autocomplete: "cc-csc" },
    { name: "cardNumber" },
    { name: "cvv" },
    { name: "security_code" },
    { autocomplete: "current-password", type: "text" },
    // Short number fields: a code, one box per digit or all six in one.
    { inputMode: "numeric", maxLength: 1 },
    { inputMode: "numeric", maxLength: 6 },
    { type: "tel", maxLength: 6 },
    { pattern: "[0-9]*", maxLength: 6 },
    // Capitals and digits run together, and more ways to name a code, a card or a password.
    { name: "OTPCode" },
    { name: "MFACode" },
    { name: "2FACode" },
    { name: "PINCode" },
    { id: "OTPInput" },
    { name: "otp1", maxLength: 1 },
    { name: "pin1" },
    { name: "pincode" },
    { name: "cardnumber" },
    { name: "code1" },
    { name: "digit-1", maxLength: 1 },
    { name: "securitycode" },
    { name: "numerKarty", maxLength: 19 },
    { name: "nr_karty" },
    { placeholder: "Numer karty" },
    { label: "Numer karty" },
    { name: "cardNo" },
    { name: "card_no" },
    { name: "ccnum" },
    { name: "ccnumber" },
    { name: "creditcard" },
    { placeholder: "1234 1234 1234 1234", inputMode: "numeric", maxLength: 19 },
    { name: "x", inputMode: "numeric", maxLength: 19 },
    { name: "pwd" },
    { name: "pw" },
    { name: "pass" },
    { name: "confirmpassword" },
    { name: "passcode" },
    { label: "Passwort" },
    { name: "api_key" },
    { name: "recoveryCode" },
    { name: "verification_code" },
    { label: "Verify it's you" },
    { type: "number", maxLength: 1 },
    { name: "card", type: "number", maxLength: 16 },
    // A text area that takes a key or a phrase.
    { tag: "TEXTAREA", name: "secret_value" },
    { tag: "TEXTAREA", name: "private_key" },
    { tag: "TEXTAREA", name: "password" },
    { tag: "TEXTAREA", name: "recovery_phrase" },
  ])
    expect([f, isSecret(input(f))]).toEqual([f, true]);
});

test("the page says when a secret field holds something a screenshot would show", () => {
  const field = (f: Field & { value: string; shown?: boolean }) => ({
    ...input(f),
    value: f.value,
    getClientRects: () => (f.shown === false ? [] : [{}]),
  });
  type Ask = { secrets?: boolean; text?: boolean; max?: number };
  const run = (fields: ReturnType<typeof field>[], ask: Ask = { secrets: true }) => {
    const page = new Function("document", "o", `return (${CONTEXT_JS})(o);`) as (
      d: unknown,
      o: unknown,
    ) => { text?: string; secretShown?: boolean };
    return page({ querySelectorAll: () => fields, body: { innerText: "Zapłać" } }, ask);
  };
  expect(
    run([field({ name: "q", value: "dune" })], { secrets: true, text: true, max: 100 }),
  ).toEqual({ text: "Zapłać", secretShown: false });
  // Each only when asked.
  expect(run([field({ name: "pin", value: "1234" })], {})).toEqual({});
  expect(run([field({ autocomplete: "cc-number", value: "4111111111111111" })]).secretShown).toBe(
    true,
  );
  expect(run([field({ name: "blikCode", value: "" })]).secretShown).toBe(false);
  expect(run([field({ name: "blikCode", value: "123456", shown: false })]).secretShown).toBe(false);
  // The element script at least compiles.
  expect(() => new Function(`return (${ELEMENT_JS});`)).not.toThrow();
});

test("ordinary fields aren't taken for secrets", () => {
  for (const f of [
    { name: "q" },
    { name: "search", placeholder: "Szukaj" },
    { name: "shippingAddress" },
    { name: "email", autocomplete: "email" },
    { name: "spinner" },
    { name: "phone", type: "tel", maxLength: 15 },
    { name: "quantity", type: "number" },
    { name: "token", type: "hidden" },
    { tag: "TEXTAREA", name: "message" },
    { name: "cardholder" },
    { name: "zip", maxLength: 6, placeholder: "00-000" },
    { name: "date", placeholder: "2026-10-17" },
    // Words that only start like a pin, an OTP or a card, and a card that isn't a payment card.
    { name: "pink" },
    { name: "ping_host" },
    { name: "pinterest_url" },
    { name: "card_title" },
    { tag: "TEXTAREA", placeholder: "Enter a title for this card…" },
    { name: "q", placeholder: "Szukaj np. karty graficzne" },
    { label: "Pan / Pani" },
    { name: "kod_pocztowy" },
    { label: "ZIP code" },
    { label: "Postal code" },
    // Inputs nobody types into, whatever they're called.
    { type: "checkbox", name: "remember_password" },
    { type: "submit", name: "verify" },
    { type: "radio", name: "pin_on_map" },
    // Words with "pass" in them, codes that aren't secret, and an email to verify.
    { name: "passenger_name" },
    { name: "passport" },
    { name: "bypass" },
    { name: "compass" },
    { name: "promoCode" },
    { name: "coupon_code" },
    { label: "Discount code" },
    { label: "Kod rabatowy" },
    { placeholder: "Verify your email" },
    { name: "verifyEmail" },
    { name: "recovery_email" },
    // Short numbers that say what they are: a postcode, a house, how many.
    { name: "zip", inputMode: "numeric", maxLength: 5 },
    { name: "house_number", inputMode: "numeric", maxLength: 6 },
    { name: "nrDomu", type: "tel", maxLength: 5 },
    { name: "qty", type: "number", maxLength: 3 },
    { type: "number", maxLength: 3 },
  ])
    expect([f, isSecret(input(f))]).toEqual([f, false]);
});

test("a page that can't be read when asked about secrets counts as showing one", async () => {
  const browser = (fail: Error) =>
    ({
      onScreen: async () => {
        throw fail;
      },
    }) as unknown as Browser;
  expect(await context(browser(new Error("Runtime.evaluate timed out")), false, true)).toEqual({
    url: null,
    title: null,
    secretShown: true,
  });
  expect(await context(browser(new Error("busy")), true, true)).toMatchObject({
    secretShown: true,
  });
  // With Chromium not running, it shows nothing; nor does a question without secrets say anything.
  expect(await context(browser(new ChromiumDown("down")), false, true)).toEqual({
    url: null,
    title: null,
  });
  expect(await context(browser(new Error("busy")), true)).toEqual({ url: null, title: null });
});

const chromium = await startChromium();
const live = test.skipIf(!chromium);
const real = new Browser(null, chromium?.endpoint);
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
  "/area": `<!doctype html><body><textarea name="private_key">-----BEGIN KEY-----</textarea></body>`,
  "/stripe": `<!doctype html><body>
    <iframe src="http://localhost:${server.port}/blank" title="Secure card payment input frame"></iframe></body>`,
  "/plain": `<!doctype html><body><input name="q" value="dune">
    <iframe src="http://localhost:${server.port}/blank" title="Map"></iframe></body>`,
  // Stripe.js's controller frame, on every page that loads it: hidden, a pixel high.
  "/stripejs": `<!doctype html><body><h1>Blog post</h1>
    <iframe name="__privateStripeController1" allow="payment *" aria-hidden="true" tabindex="-1"
      src="http://localhost:${server.port}/blank?js.stripe.com"
      style="border:none;width:1px;min-width:100%;display:block;visibility:hidden;position:fixed;height:1px"></iframe></body>`,
  "/video": `<!doctype html><body>
    <iframe src="http://localhost:${server.port}/blank" title="Karty graficzne RTX 3060 - test"></iframe></body>`,
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
  "/opener": `<!doctype html><body style="margin:0">
    <button style="width:100px;height:40px" onclick="window.open('/area', 'pay', 'width=400,height=300')">Pay</button></body>`,
});

/** Whether a secret shows on the page, once loaded: navigate waits for its frames to load too. */
async function shown(path: string): Promise<boolean | undefined> {
  await real.call("navigate", { url: `${base}${path}` });
  return (await context(real, false, true)).secretShown;
}

live(
  "a secret shows in an open shadow root, a same-origin frame, a text area or a payment frame",
  async () => {
    expect(await shown("/shadow")).toBe(true);
    expect(await shown("/frame")).toBe(true);
    expect(await shown("/area")).toBe(true);
    expect(await shown("/stripe")).toBe(true);
    expect(await shown("/plain")).toBe(false);
    expect(await shown("/stripejs")).toBe(false);
    expect(await shown("/video")).toBe(false);
  },
  20_000,
);

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

live("a secret in a popup's window shows, though the tab under it is the active one", async () => {
  expect(await shown("/opener")).toBe(false);
  await real.call("left_click", { target: { type: "coordinate", x: 20, y: 20 } });
  // The popup loads in its own time.
  let page = await context(real, false, true);
  for (let i = 0; !page.secretShown && i < 50; i++) {
    await Bun.sleep(100);
    page = await context(real, false, true);
  }
  expect(page).toMatchObject({ url: `${base}/opener`, secretShown: true });
  const popup = (await real.state()).tabs.find((t) => t.url.endsWith("/area"));
  await real.call("close_tab", { tab_id: popup?.tab_id });
  expect((await context(real, false, true)).secretShown).toBe(false);
});
