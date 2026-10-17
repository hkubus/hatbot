import { expect, test } from "bun:test";
import { CONTEXT_JS, ELEMENT_JS, SECRET } from "../src/cdp";

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
  ])
    expect([f, isSecret(input(f))]).toEqual([f, true]);
});

test("the page says when a secret field holds something a screenshot would show", () => {
  const field = (f: Field & { value: string; shown?: boolean }) => ({
    ...input(f),
    value: f.value,
    getClientRects: () => (f.shown === false ? [] : [{}]),
  });
  const run = (fields: ReturnType<typeof field>[]) => {
    const page = new Function("document", `return (${CONTEXT_JS})({ max: 100, text: true });`) as (
      d: unknown,
    ) => { text?: string; secretShown: boolean };
    return page({ querySelectorAll: () => fields, body: { innerText: "Zapłać" } });
  };
  expect(run([field({ name: "q", value: "dune" })])).toEqual({
    text: "Zapłać",
    secretShown: false,
  });
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
  ])
    expect([f, isSecret(input(f))]).toEqual([f, false]);
});
