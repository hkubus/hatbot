// The exact-text send gate's rules, without a desktop (PLAN.md §16.3).
import { expect, test } from "bun:test";
import type { AgentElement } from "@hatbot/shared/desktop";
import {
  collapse,
  type GateState,
  gateCheck,
  onConversation,
  pressesEnter,
  refused,
  type SendGate,
  sameAddress,
  typesText,
} from "../src/negotiate/gate";

const LISTING = "https://www.olx.pl/d/oferta/karta-rtx-3070-CID99-ID1001abc.html";
const TEXT = "Dzień dobry, czy przyjmie Pan 1100 zł?";
const gate: SendGate = {
  mode: "send",
  text: TEXT,
  listingUrl: LISTING,
  listingId: "1001abc",
  conversationUrl: "https://www.olx.pl/myaccount/answers/555?ad=1001abc",
};
const ready: GateState = { recorded: true, sent: false };
const send = (over: Partial<AgentElement> = {}): AgentElement => ({
  tag: "button",
  role: null,
  type: "submit",
  label: "Wyślij",
  inForm: true,
  url: LISTING,
  editable: false,
  fields: [TEXT],
  ...over,
});

test("the approved text on the listing or the conversation passes as the send", () => {
  expect(gateCheck(gate, ready, "click", send(), "Wyślij")).toEqual({ action: "send" });
  expect(gateCheck(gate, ready, "enter", send({ tag: "textarea" }), null)).toEqual({
    action: "send",
  });
  // Whitespace and invisible characters don't count.
  const spaced = send({ fields: [`  Dzień  dobry,\nczy przyjmie​ Pan 1100 zł? `] });
  expect(gateCheck(gate, ready, "click", spaced, null)).toEqual({ action: "send" });
  const there = send({ url: "https://olx.pl/myaccount/answers/555/?ad=1001abc&tab=1" });
  expect(gateCheck(gate, ready, "click", there, null)).toEqual({ action: "send" });
});

test("other text, more text, or the wrong place is held", () => {
  const other = gateCheck(gate, ready, "click", send({ fields: ["Kupię za 2000 zł"] }), null);
  expect(other.action).toBe("hold");
  expect(JSON.stringify(other)).toContain("isn't exactly the approved message");
  const extra = gateCheck(gate, ready, "click", send({ fields: [TEXT, "rtx"] }), null);
  expect(extra.action).toBe("hold");
  const edited = gateCheck(gate, ready, "click", send({ fields: [`${TEXT} 1500?`] }), null);
  expect(edited.action).toBe("hold");
  // Marks that show the seller other digits: a bidi override shows 1100 as 0011, ⑪ reads as 11.
  for (const field of [
    "Dzień dobry, czy przyjmie Pan ‮1100‬ zł?",
    "Dzień dobry, czy przyjmie Pan ⁦‮1100⁩ zł?",
    "Dzień dobry, czy przyjmie Pan ⑪00 zł?",
  ])
    expect(gateCheck(gate, ready, "click", send({ fields: [field] }), null).action).toBe("hold");

  const elsewhere = gateCheck(
    gate,
    ready,
    "click",
    send({ url: "https://www.olx.pl/myaccount/answers/777" }),
    null,
  );
  expect(elsewhere.action).toBe("hold");
  expect(JSON.stringify(elsewhere)).toContain("isn't the negotiation's conversation");
  const otherSite = gateCheck(
    gate,
    ready,
    "click",
    send({ url: "https://evil.example/d/oferta/karta-rtx-3070-CID99-ID1001abc.html" }),
    null,
  );
  expect(otherSite.action).toBe("hold");
});

test("before record_conversation, after a send, or once stopped, nothing goes", () => {
  const first = gateCheck(gate, { recorded: false, sent: false }, "click", send(), null);
  expect(JSON.stringify(first)).toContain("record_conversation first");
  const again = gateCheck(gate, { recorded: true, sent: true }, "click", send(), null);
  expect(JSON.stringify(again)).toContain("sent once already");
  const stopped = gateCheck(
    gate,
    { recorded: true, sent: false, stopped: "The seller wrote meanwhile." },
    "click",
    send(),
    null,
  );
  expect(stopped).toEqual({ action: "hold", why: "The seller wrote meanwhile." });
});

test("empty boxes take the usual check; a click into a box passes; pay buttons still ask", () => {
  expect(gateCheck(gate, ready, "click", send({ fields: [] }), "Wyślij")).toEqual({
    action: "usual",
  });
  expect(
    gateCheck(gate, ready, "click", send({ tag: "textarea", editable: true }), "Reply"),
  ).toEqual({ action: "pass" });
  expect(gateCheck(gate, ready, "click", send({ label: "Kup teraz" }), "Kup teraz")).toEqual({
    action: "usual",
  });
});

test("an unknown element or an old desktop-agent is held", () => {
  expect(gateCheck(gate, ready, "click", null, null).action).toBe("hold");
  const old = send();
  delete old.fields;
  delete old.url;
  expect(JSON.stringify(gateCheck(gate, ready, "click", old, null))).toContain("out of date");
});

test("a seller's link is never opened, however it's written or reached", () => {
  for (const url of [
    "evil.example/pay",
    "//evil.example",
    "https://bit.ly/pay-here",
    " http://olx.pl.evil.example/ ",
    "javascript:alert(1)",
  ])
    expect([url, refused(gate, "navigate", { url })]).toEqual([
      url,
      expect.stringContaining("Never open a link"),
    ]);
  for (const url of ["olx.pl/d/oferta/x", "www.olx.pl/myaccount/answers", "back", "reload"])
    expect([url, refused(gate, "navigate", { url })]).toEqual([url, null]);
  // The address bar and new windows are another way there.
  for (const text of ["ctrl+l", "alt+d", "F6", "ctrl+t", "ctrl+shift+n"])
    expect(refused(gate, "key", { text })).toContain("Use navigate");
  expect(refused(gate, "key", { text: "ctrl+a" })).toBeNull();

  // A link in the chat: off the site, through the site's redirect, or another kind of address.
  const link = (href: string) => send({ tag: "a", type: null, label: "kliknij", href });
  for (const href of [
    "https://evil.example/olx-pay",
    "https://www.olx.pl/redirect?url=https%3A%2F%2Fevil.example%2F",
    "mailto:seller@example.com",
  ]) {
    expect(gateCheck(gate, ready, "click", link(href), null).action).toBe("hold");
    expect(gateCheck(gate, ready, "enter", link(href), null).action).toBe("hold");
  }
  expect(gateCheck(gate, ready, "click", link(LISTING), null)).toEqual({ action: "send" });
  expect(gateCheck(gate, ready, "click", send({ href: "javascript:void(0)" }), "Wyślij")).toEqual({
    action: "send",
  });
});

test("once something's typed, a click or Enter that sees no text box is held", () => {
  const typed: GateState = { ...ready, typed: true };
  const blind = send({ fields: [] });
  expect(JSON.stringify(gateCheck(gate, typed, "click", blind, null))).toContain(
    "can't see the text box",
  );
  expect(
    gateCheck(gate, typed, "enter", { ...blind, tag: "div", editable: true }, null).action,
  ).toBe("hold");
  // A link on the listing's site needs no box; before typing, or after the send, the usual check decides.
  const back = send({ fields: [], tag: "a", href: "https://www.olx.pl/myaccount/answers" });
  expect(gateCheck(gate, typed, "click", back, null)).toEqual({ action: "usual" });
  expect(gateCheck(gate, ready, "click", blind, null)).toEqual({ action: "usual" });
  expect(gateCheck(gate, { ...typed, sent: true }, "click", blind, null)).toEqual({
    action: "usual",
  });
  expect(typesText("type", { text: "a" })).toBe(true);
  expect(typesText("key", { text: "ctrl+v" })).toBe(true);
  expect(typesText("key", { text: "Tab" })).toBe(false);
});

test("a click in a frame isn't the send; a click on the page itself sends nothing", () => {
  const frame = send({ tag: "iframe", type: null, label: "Płatność" });
  expect(gateCheck(gate, ready, "click", frame, null)).toEqual({ action: "usual" });
  expect(gateCheck(gate, ready, "click", send({ tag: "body", type: null }), null)).toEqual({
    action: "pass",
  });
});

test("a read-only task sends nothing", () => {
  const read: SendGate = { ...gate, mode: "read", text: null };
  expect(gateCheck(read, ready, "click", send(), "Wyślij").action).toBe("hold");
  expect(gateCheck(read, ready, "click", send({ fields: [] }), "Wyślij")).toEqual({
    action: "usual",
  });
  expect(refused(read, "type", { text: "hello" })).toContain("only reads");
  expect(refused(read, "form_input", { value: "hello" })).toContain("only reads");
});

test("actions that could send unseen are refused", () => {
  expect(refused(gate, "left_mouse_down", {})).toContain("left_click");
  expect(refused(gate, "left_click_drag", {})).toContain("left_click");
  expect(refused(gate, "type", { text: `${TEXT}\n` })).toContain("without line breaks");
  expect(refused(gate, "type", { text: TEXT })).toBeNull();
  expect(refused(gate, "key", { text: "Return", repeat: 2 })).toContain("once");
  expect(refused(gate, "navigate", { url: "https://bit.ly/pay-here" })).toContain(
    "Never open a link",
  );
  expect(refused(gate, "navigate", { url: "https://www.olx.pl/myaccount/answers" })).toBeNull();
  expect(refused(gate, "navigate", { url: "back" })).toBeNull();
});

test("Enter anywhere in a key press is checked", () => {
  expect(pressesEnter("Return")).toBe(true);
  expect(pressesEnter("shift+Return")).toBe(true);
  expect(pressesEnter("a KP_Enter")).toBe(true);
  expect(pressesEnter("ctrl+a BackSpace")).toBe(false);
  // The message is one paragraph.
  expect(refused(gate, "key", { text: "shift+Return" })).toContain("no new lines");
  expect(refused(gate, "key", { text: "ctrl+Return" })).toBeNull();
});

test("addresses match by host, path and the query they need", () => {
  expect(sameAddress("https://olx.pl/a/b/", "https://www.olx.pl/a/b")).toBe(true);
  expect(sameAddress("https://www.olx.pl/a/b?x=1", "https://www.olx.pl/a/b?x=2")).toBe(false);
  expect(sameAddress("https://www.olx.pl/a/c", "https://www.olx.pl/a/b")).toBe(false);
  expect(onConversation("https://www.olx.pl/chat/ID1001abc/", gate)).toBe(false);
  expect(onConversation("https://www.olx.pl/chat/1001abc/", gate)).toBe(true);
  expect(onConversation("https://www.olx.pl/chat?ad=1001abc", gate)).toBe(true);
  expect(onConversation("https://www.olx.pl/chat?ad=1001abcd", gate)).toBe(false);
  expect(collapse(" a \n b​ ")).toBe("a b");
  // Fullwidth digits, soft hyphens and direction marks compare as what they show.
  expect(collapse("Dam １­５００‎ zł")).toBe("Dam 1500 zł");
  expect(collapse("Dam 1 500")).toBe(collapse("Dam 1 500"));
});
