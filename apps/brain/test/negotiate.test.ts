// Negotiation (PLAN.md §16), N1: the appraisal against a stand-in Scout, the tools in the chat, and the
// exact-text send gate against a stand-in desktop.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mandate, Negotiation } from "@hatbot/shared";
import type { AgentElement } from "@hatbot/shared/desktop";
import { mcpPlugin } from "../src/plugins/mcp";
import type { CallContext, PluginTool } from "../src/plugins/plugin";
import { runPluginTool, verdictFor } from "../src/plugins/registry";
import { sendConfirm } from "../src/tasks/desktop-run";
import { browser, computer, FakeModel, text, toolUse } from "./fake-model";
import { type TestApp, testApp, waitFor } from "./helpers";

sendConfirm.everyMs = 1;

const LISTING_URL = "https://www.olx.pl/d/oferta/karta-rtx-3070-CID99-ID1001.html";
const CHAT_URL = "https://www.olx.pl/myaccount/answers/555";
const TEXT = "Dzień dobry, czy przyjmie Pan 1060 zł za kartę?";
const call = (): CallContext => ({ task: null, signal: new AbortController().signal });

const finish = (summary = "Sent it.") => ({
  content: [toolUse("finish_task", { outcome: "done", summary })],
});

/** The MCP plugin with the stand-in Scout, its read tools set to Chat. */
async function withScout(t: TestApp, full: boolean, modes: Record<string, string> = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "hatbot-scout-")), "calls.jsonl");
  const info = await t.plugins.update("mcp", {
    enabled: true,
    config: {
      servers: [
        {
          name: "scout",
          transport: "stdio",
          command: process.execPath,
          args: [join(import.meta.dir, "fixtures/scout-server.ts")],
          env: { SCOUT_LOG: log, ...(full ? { SCOUT_FULL: "1" } : {}) },
          tools: {
            scout_listing_detail: "chat",
            scout_watch_analytics: "chat",
            scout_price_reference: "chat",
            scout_comparables: "chat",
            ...modes,
          },
        },
      ],
    },
  });
  expect(info.state).toBe("ready");
  const calls = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { tool: string }).tool);
  return { calls };
}

const negotiateTools = (t: TestApp) =>
  t.negotiations.tools(t.bots.hatbot(), t.plugins.tools(), { conversationId: null });
const named = (tools: PluginTool[], name: string) => {
  const found = tools.find((x) => x.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

const MANDATE: Mandate = {
  currency: "PLN",
  opening: 1060,
  target: 1250,
  limit: 1400,
  delivery: "OLX delivery with buyer protection",
  expiresAt: "2026-10-16T12:00:00.000Z",
  allow: [],
};

/** An open negotiation on the stand-in listing, made directly. */
function openNegotiation(t: TestApp, over: Partial<Negotiation> = {}): Negotiation {
  const bot = t.bots.hatbot();
  const n = t.negotiations.create({
    bot,
    wantId: t.negotiations.wantFor(bot, "an RTX 3070", "RTX 3070"),
    listing: {
      key: "OLX:1001",
      marketplace: "OLX",
      title: "Karta graficzna RTX 3070 8GB",
      url: LISTING_URL,
      asking: 1500,
      typical: null,
      watchId: null,
      negotiable: true,
      listedAt: null,
      history: [],
    },
    mandate: MANDATE,
    appraisal: null,
    status: "open",
    conversationId: null,
  });
  if (over.conversationUrl) t.negotiations.update(n.id, { conversation_url: over.conversationUrl });
  return t.negotiations.get(n.id) as Negotiation;
}

/** The listing page's message box and its Send button, as desktop-agent shows them. */
function messageBox(t: TestApp, url = LISTING_URL) {
  let fields: string[] = [];
  const button = (): AgentElement => ({
    tag: "button",
    role: null,
    type: "submit",
    label: "Wyślij",
    inForm: true,
    url,
    editable: false,
    fields,
  });
  Object.defineProperty(t.agent, "element", { get: button, configurable: true });
  t.agent.health = { features: ["profiles", "exec", "files", "fields"] };
  t.agent.page = { url, title: "OLX", text: "" };
  const box = {
    /** Clicking Send empties the box, as a page does once the message is sent. */
    sends: true,
    set: (v: string[]) => {
      fields = v;
    },
  };
  t.agent.afterAction = (name, input) => {
    if (name === "type") fields = [`${fields[0] ?? ""}${String(input.text)}`];
    if (name === "key" && input.text === "ctrl+a BackSpace") fields = [];
    if (box.sends && (name === "left_click" || name === "key") && fields.length) {
      if (name === "key" && input.text !== "Return") return;
      fields = [];
      t.agent.page = { url: CHAT_URL, title: "OLX", text: "" };
    }
  };
  return box;
}

const results = (model: FakeModel, i: number) => JSON.stringify(model.requests[i]?.messages.at(-1));

test("with no Scout connected, the negotiate tools aren't offered", async () => {
  const chat = new FakeModel([{ content: [text("Hi.")] }]);
  const t = await testApp(chat);
  expect(negotiateTools(t)).toEqual([]);
  t.thread.post("haggle for me");
  await t.thread.idle();
  const offered = (chat.requests[0]?.tools ?? []).map((x) => (x as { name: string }).name);
  expect(offered).toContain("run_desktop_task");
  expect(offered.some((n) => n.startsWith("negotiate_"))).toBe(false);
});

test("the appraisal falls back to the watch's prices and the listing, while Scout has no price reference", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, false);
  const tools = negotiateTools(t);
  expect(tools.map((x) => x.name)).toEqual([
    "negotiate_appraise",
    "negotiate_start",
    "negotiate_list",
    "negotiate_get",
    "negotiate_send",
    "negotiate_check",
    "negotiate_close",
  ]);
  const appraise = named(tools, "negotiate_appraise");
  expect(verdictFor(appraise, { listing: "OLX:1001" }, call(), true).action).toBe("allow");
  const r = await runPluginTool(appraise, { listing: "OLX:1001" }, call());
  expect(r.isError).toBe(false);
  // Scout's answers are untrusted, and so is what's made of them.
  expect(r.content).toContain('trusted="false"');
  const out = await appraise.run({ listing: "OLX:1001" }, call());
  expect(out).toContain("Asking 1,500 zł.");
  expect(out).toContain("Open at 1,060 zł, aim for 1,250 zł, walk away above 1,400 zł.");
  expect(out).toContain(
    `Basis: Scout's watch "RTX 3070": today's median asking price over 31 listings; the price dropped from 1,650 zł to 1,500 zł; listed 8 days ago; the seller marked the price as negotiable.`,
  );
  expect(out).toContain("- Cheapest listed now: 1,100 zł");
  expect(scout.calls()).toEqual([
    "scout_listing_detail",
    "scout_watch_analytics",
    "scout_listing_detail",
    "scout_watch_analytics",
  ]);
  await t.plugins.stopAll();
});

test("the appraisal uses Scout's price reference and comparables once they're there", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, true);
  const out = await named(negotiateTools(t), "negotiate_appraise").run(
    { listing: "OLX:1001" },
    call(),
  );
  expect(out).toContain("Open at 1,020 zł, aim for 1,200 zł, walk away above 1,290 zł.");
  expect(out).toContain(`Basis: Scout's price reference for "RTX 3070" from 40 listings;`);
  expect(out).toContain("- RTX 3070 Gaming OC: 1,290 zł https://www.olx.pl/d/oferta/x-ID2002.html");
  expect(scout.calls()).toEqual([
    "scout_listing_detail",
    "scout_price_reference",
    "scout_comparables",
  ]);
  await t.plugins.stopAll();
});

test("Scout's tools must be set to Chat; one that asks isn't used", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  await withScout(t, false, { scout_listing_detail: "ask" });
  const r = await runPluginTool(
    named(negotiateTools(t), "negotiate_appraise"),
    { listing: "OLX:1001" },
    call(),
  );
  expect(r.isError).toBe(true);
  expect(r.content).toContain("Set it to Chat");
  // An unknown listing says so.
  await t.plugins.update("mcp", {
    config: {
      servers: [
        {
          name: "scout",
          transport: "stdio",
          command: process.execPath,
          args: [join(import.meta.dir, "fixtures/scout-server.ts")],
          tools: { scout_listing_detail: "chat" },
        },
      ],
    },
  });
  const missing = await runPluginTool(
    named(negotiateTools(t), "negotiate_appraise"),
    { listing: "OLX:9" },
    call(),
  );
  expect(missing.isError).toBe(true);
  await t.plugins.stopAll();
});

test("negotiate_start shows under the reply without asking; every negotiate_send asks (N1)", async () => {
  const chat = new FakeModel([
    { content: [toolUse("negotiate_appraise", { listing: "OLX:1001" })] },
    {
      content: [
        text("Starting."),
        toolUse("negotiate_start", {
          listing: "OLX:1001",
          mandate: { opening: 1060, target: 1250, limit: 1400, delivery: "OLX delivery" },
          want: "an RTX 3070 for the media PC",
        }),
      ],
    },
    { content: [toolUse("negotiate_send", { negotiation: 1, text: TEXT, offer: 1060 })] },
    { content: [text("You said no, so nothing went.")] },
  ]);
  const t = await testApp(chat, new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, false);
  t.thread.post("Haggle for OLX:1001, up to 1400");
  const approval = await waitFor(() => t.approvals.list(true)[0]);
  expect(approval.kind).toBe("send");
  expect(approval.summary).toContain(`"${TEXT}"`);
  expect(approval.summary).toContain("offer 1,060 zł");
  expect(approval.reason).toContain("Every message to a seller asks you first");

  // The appraisal was made once: negotiate_start used it.
  expect(scout.calls()).toEqual(["scout_listing_detail", "scout_watch_analytics"]);
  const n = t.negotiations.get(1);
  expect(n?.status).toBe("open");
  expect(n?.want).toBe("an RTX 3070 for the media PC");
  expect(n?.mandate).toMatchObject({ opening: 1060, target: 1250, limit: 1400, allow: [] });
  expect(n?.mandate.expiresAt).toBe("2026-10-16T12:00:00.000Z");
  expect(n?.appraisal?.walkAway).toBe(1400);
  expect(t.thread.list().find((m) => m.negotiationId === 1)?.role).toBe("assistant");
  expect(t.events.some((e) => e.type === "negotiation.updated")).toBe(true);

  t.approvals.decide(approval.id, "deny", "web");
  await t.thread.idle();
  expect(results(chat, 3)).toContain("The owner denied this");
  expect(t.negotiations.messages(1)).toEqual([]);
  expect(t.tasks.list().length).toBe(0);

  // A second negotiation on the same listing isn't started.
  const again = await runPluginTool(
    named(negotiateTools(t), "negotiate_start"),
    {
      listing: "OLX:1001",
      mandate: { opening: 1000, target: 1100, limit: 1200, delivery: "OLX delivery" },
    },
    call(),
  );
  expect(again.content).toContain("already open on this listing");
  // Numbers out of order aren't a mandate.
  const bad = await runPluginTool(
    named(negotiateTools(t), "negotiate_start"),
    {
      listing: "OLX:1001",
      mandate: { opening: 1300, target: 1250, limit: 1400, delivery: "OLX delivery" },
    },
    call(),
  );
  expect(bad.content).toContain("opening ≤ target ≤ limit");
  await t.plugins.stopAll();
});

test("closing writes the bot's notes; agreeing outside the mandate asks", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  await withScout(t, false);
  const n = openNegotiation(t);
  const close = named(negotiateTools(t), "negotiate_close");
  const over = { negotiation: n.id, outcome: "agreed", price: 1450 };
  expect(verdictFor(close, close.schema.parse(over), call(), true)).toMatchObject({
    action: "ask",
    kind: "purchase",
  });
  const within = close.schema.parse({ ...over, price: 1300, notes: "Took 1300 after two rounds." });
  expect(verdictFor(close, within, call(), true).action).toBe("allow");
  const r = await runPluginTool(close, within, call());
  expect(r.content).toContain("is agreed");
  expect(t.negotiations.get(n.id)).toMatchObject({ status: "agreed", agreedPrice: 1300 });
  const notes = await t.memory.read("negotiations.md");
  expect(notes).toContain("agreed at 1300 PLN; asking 1500, opened 1060, aimed 1250, limit 1400.");
  expect(notes).toContain("Took 1300 after two rounds.");
  expect(verdictFor(close, within, call(), true)).toMatchObject({ action: "block" });
  await t.plugins.stopAll();
});

test("the send gate: exactly the approved text, once, on the conversation, after it's recorded", async () => {
  const work = new FakeModel([
    { content: [computer("type", { text: TEXT })] },
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    { content: [toolUse("record_conversation", { messages: [] })] },
    { content: [computer("key", { text: "ctrl+a BackSpace" })] },
    { content: [computer("type", { text: "Kupię za 2000 zł, proszę o numer telefonu" })] },
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    { content: [computer("key", { text: "ctrl+a BackSpace" })] },
    { content: [computer("type", { text: TEXT })] },
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    { content: [computer("type", { text: TEXT })] },
    { content: [computer("key", { text: "Return" })] },
    { content: [toolUse("record_conversation", { messages: [{ from: "us", text: TEXT }] })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), work);
  messageBox(t);
  const n = openNegotiation(t);
  await t.negotiations.desktopReady();
  const said = await t.negotiations.send(
    n,
    { text: ` ${TEXT}\n`, offer: 1060, agree: false, stated: null },
    call(),
  );
  expect(said).toContain("Sending it in desktop task #1");
  expect(t.negotiations.messages(n.id)[0]).toMatchObject({ status: "sending", taskId: 1 });
  await t.tasks.idle();

  // The click before record_conversation, and the one with other text, never reached the desktop.
  expect(results(work, 2)).toContain("Call record_conversation first");
  expect(results(work, 6)).toContain("isn't exactly the approved message");
  expect(results(work, 9)).toContain("The message went");
  expect(results(work, 11)).toContain("sent once already");
  expect(t.agent.actions.filter((a) => a.name === "left_click")).toHaveLength(1);
  expect(t.agent.actions.some((a) => a.name === "key" && a.input.text === "Return")).toBe(false);
  // No confirm_intent, and nothing asked the owner: the message itself was approved.
  expect(t.approvals.list(false).length).toBe(0);

  const [m] = t.negotiations.messages(n.id);
  expect(m).toMatchObject({ status: "sent", text: TEXT, offer: 1060 });
  expect(m?.sentAt).toBeTruthy();
  expect(t.negotiations.get(n.id)?.conversationUrl).toBe(CHAT_URL);
  const steps = t.tasks.steps(1).map((s) => s.name);
  expect(steps).toContain("Sent the approved message");
  expect(t.tasks.get(1)?.status).toBe("done");
  expect(t.agent.profiles).toEqual(["hatbot"]);
  // The task was offered record_conversation; other tasks aren't.
  expect(JSON.stringify(work.requests[0]?.tools)).toContain("record_conversation");
});

test("the send gate holds on the wrong conversation, and the send fails when the task ends", async () => {
  const work = new FakeModel([
    { content: [toolUse("record_conversation", { messages: [] })] },
    { content: [computer("type", { text: TEXT })] },
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    { content: [browser("navigate", { url: "https://bit.ly/olx-pay" })] },
    finish("Couldn't send it there."),
  ]);
  const t = await testApp(new FakeModel(), work);
  messageBox(t, "https://www.olx.pl/myaccount/answers/777");
  const n = openNegotiation(t, { conversationUrl: CHAT_URL });
  await t.negotiations.send(n, { text: TEXT, offer: 1060, agree: false, stated: null }, call());
  await t.tasks.idle();
  expect(results(work, 3)).toContain("isn't the negotiation's conversation");
  expect(results(work, 4)).toContain("Never open a link from the seller");
  expect(t.agent.actions.some((a) => a.name === "left_click")).toBe(false);
  expect(t.agent.browserCalls).toEqual([]);
  await waitFor(() => t.negotiations.messages(n.id)[0]?.status === "failed");
  // A failed send leaves nothing in flight, so the next may go.
  expect(t.negotiations.inFlight(n.id)).toBeNull();
});

test("a seller's reply that came meanwhile stops the send", async () => {
  const work = new FakeModel([
    {
      content: [
        toolUse("record_conversation", {
          messages: [
            { from: "us", text: "Dzień dobry, czy aktualne?" },
            { from: "seller", text: "Tak, aktualne. Cena do negocjacji." },
          ],
        }),
      ],
    },
    { content: [computer("type", { text: TEXT })] },
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    finish("The seller wrote first."),
  ]);
  const t = await testApp(new FakeModel(), work);
  messageBox(t, CHAT_URL);
  const n = openNegotiation(t, { conversationUrl: CHAT_URL });
  await t.negotiations.send(n, { text: TEXT, offer: 1060, agree: false, stated: null }, call());
  await t.tasks.idle();
  expect(results(work, 1)).toContain("The seller wrote since this message was approved");
  expect(results(work, 3)).toContain("The seller wrote since this message was approved");
  expect(t.agent.actions.some((a) => a.name === "left_click")).toBe(false);
  const messages = t.negotiations.messages(n.id);
  expect(messages.map((m) => [m.direction, m.status])).toEqual([
    ["out", "failed"],
    ["in", "received"],
  ]);
  expect(messages[1]?.text).toBe("Tak, aktualne. Cena do negocjacji.");
});

test("a message already in the conversation counts as sent; a click that leaves the text is unconfirmed", async () => {
  const already = new FakeModel([
    { content: [toolUse("record_conversation", { messages: [{ from: "us", text: TEXT }] })] },
    { content: [computer("type", { text: TEXT })] },
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    finish(),
  ]);
  const t = await testApp(new FakeModel(), already);
  messageBox(t, CHAT_URL);
  const n = openNegotiation(t, { conversationUrl: CHAT_URL });
  await t.negotiations.send(n, { text: TEXT, offer: 1060, agree: false, stated: null }, call());
  await t.tasks.idle();
  expect(results(already, 1)).toContain("it went. Don't send it again");
  expect(t.agent.actions.some((a) => a.name === "left_click")).toBe(false);
  expect(t.negotiations.messages(n.id)[0]?.status).toBe("sent");

  const stuck = new FakeModel([
    { content: [toolUse("record_conversation", { messages: [] })] },
    { content: [computer("type", { text: TEXT })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_1" } })] },
    finish(),
  ]);
  const u = await testApp(new FakeModel(), stuck);
  messageBox(u, LISTING_URL).sends = false;
  const m = openNegotiation(u);
  await u.negotiations.send(m, { text: TEXT, offer: 1060, agree: false, stated: null }, call());
  await u.tasks.idle();
  expect(results(stuck, 3)).toContain("it may not have gone");
  expect(u.agent.browserCalls.map((c) => c.name)).toEqual(["left_click"]);
  expect(u.negotiations.messages(m.id)[0]?.status).toBe("unconfirmed");
  expect(u.tasks.steps(1).map((s) => s.name)).toContain("Not sure the message went");
});

test("a read-only task records the seller and the conversation, and types and sends nothing", async () => {
  const work = new FakeModel([
    { content: [computer("type", { text: "hello" })] },
    {
      content: [
        toolUse("record_conversation", {
          messages: [
            { from: "seller", text: "Mogę zejść do 1350." },
            { from: "seller", text: "Mogę zejść do 1350." },
          ],
        }),
      ],
    },
    { content: [toolUse("confirm_intent", { kind: "send", summary: "Reply" })] },
    { content: [computer("left_click", { coordinate: [300, 500] })] },
    {
      content: [
        toolUse("record_conversation", {
          messages: [{ from: "seller", text: "Mogę zejść do 1350." }],
        }),
      ],
    },
    finish("The seller can do 1350."),
  ]);
  const t = await testApp(new FakeModel(), work);
  const box = messageBox(t, CHAT_URL);
  box.set(["leftover draft"]);
  const n = openNegotiation(t);
  const said = await t.negotiations.check(n, call());
  expect(said).toContain("Reading the conversation in desktop task #1");
  await t.tasks.idle();
  expect(results(work, 1)).toContain("only reads");
  expect(results(work, 2)).toContain("Recorded 2 new messages from the seller.");
  expect(results(work, 3)).toContain("this task only reads");
  expect(results(work, 4)).toContain("this task only reads the conversation");
  expect(results(work, 5)).toContain("Nothing new from the seller.");
  expect(t.agent.actions).toEqual([]);
  expect(t.approvals.list(false).length).toBe(0);
  expect(t.negotiations.messages(n.id).map((m) => m.text)).toEqual([
    "Mogę zejść do 1350.",
    "Mogę zejść do 1350.",
  ]);
  expect(t.negotiations.get(n.id)?.conversationUrl).toBe(CHAT_URL);
});

test("an older desktop-agent can't send", async () => {
  const t = await testApp();
  t.agent.health = { features: ["profiles", "exec", "files"] };
  await expect(t.negotiations.desktopReady()).rejects.toThrow("run Update first");
});
