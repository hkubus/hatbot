// Listing Scout's flips: marked ready there, posted on each marketplace in its own desktop task, Scout told
// where each went; against a stand-in Scout and a stand-in desktop.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpPlugin } from "@hatbot/plugin-mcp";
import type { AgentElement } from "@hatbot/shared/desktop";
import {
  type ListingGate,
  listingCheck,
  listingRefused,
  type TakeDownGate,
  takeDownCheck,
  takeDownRefused,
} from "../src/listings/gate";
import { browser, FakeModel, toolUse } from "./fake-model";
import { type TestApp, tempDirs, testApp, waitFor } from "./helpers";

const TITLE = "Karta graficzna RTX 3070 8GB";
const DESCRIPTION = "Sprawna, bez kopania.\nWysyłka w oryginalnym pudełku.";
const OLX_ADD = "https://www.olx.pl/adding/";
const OLX_URL = "https://www.olx.pl/d/oferta/karta-rtx-3070-CID99-ID777.html";
const VINTED_URL = "https://www.vinted.pl/items/888-karta-rtx-3070";

type Flip = {
  id: number;
  updatedAt: string;
  title: string;
  description: string;
  condition: string;
  category: string;
  delivery: { shipping: boolean; pickup: boolean; parcelSize: string | null };
  prices: Record<string, number>;
  currency: string;
  photos: { id: number; mime: string }[];
  channels: Record<string, string>;
  listed?: Record<string, unknown>[];
  soldOn?: string;
  saleChannel?: string;
  delisted?: string[];
};

const flip = (over: Partial<Flip> = {}): Flip => ({
  id: 7,
  updatedAt: "2026-10-09T10:00:00Z",
  title: TITLE,
  description: DESCRIPTION,
  condition: "good",
  category: "Karty graficzne",
  delivery: { shipping: true, pickup: true, parcelSize: "medium" },
  prices: { OLX: 1199, Vinted: 1249 },
  currency: "PLN",
  photos: [
    { id: 1, mime: "image/jpeg" },
    { id: 2, mime: "image/jpeg" },
  ],
  channels: { OLX: "ready", Vinted: "ready" },
  ...over,
});

/** The MCP plugin with the stand-in Scout and its flips, its reads on Chat and its write on Allow. */
async function withScout(t: TestApp, flips: Flip[], listed = "allow") {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-scout-"));
  tempDirs.push(dir);
  const log = join(dir, "calls.jsonl");
  const file = join(dir, "flips.json");
  writeFileSync(file, JSON.stringify(flips));
  const server = {
    name: "scout",
    transport: "stdio",
    command: process.execPath,
    args: [join(import.meta.dir, "fixtures/scout-server.ts")],
    env: { SCOUT_LOG: log, SCOUT_FLIPS: file },
    tools: {
      scout_flips_to_list: "chat",
      scout_flip: "chat",
      scout_flip_photo: "chat",
      scout_flip_listed: listed,
      scout_flips_to_take_down: "chat",
      scout_flip_taken_down: listed,
    },
  };
  await t.plugins.update("mcp", { enabled: true, config: { servers: [server] } });
  const seen = (await t.plugins.action("mcp", "status", {})) as {
    tools: { name: string; hash: string }[];
  }[];
  const pinned = Object.fromEntries(seen[0]?.tools.map((x) => [x.name, x.hash]) ?? []);
  const info = await t.plugins.update("mcp", { config: { servers: [{ ...server, pinned }] } });
  expect(info.state).toBe("ready");
  return {
    flips: (): Flip[] => JSON.parse(readFileSync(file, "utf8")),
    set: (f: Flip[]) => writeFileSync(file, JSON.stringify(f)),
    calls: (tool: string) =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { tool: string; input: Record<string, unknown> })
            .filter((c) => c.tool === tool)
            .map((c) => c.input)
        : [],
  };
}

/**
 * An add-listing page: form_input fills its boxes by ref, the publish button (ref_9) sends the form
 * and opens the new listing, set by `published`.
 */
function addPage(t: TestApp, published: Record<string, string>) {
  const boxes = new Map<string, string>();
  const button = (): AgentElement => ({
    tag: "button",
    role: null,
    type: "submit",
    label: "Dodaj ogłoszenie",
    inForm: true,
    url: t.agent.page.url ?? "",
    editable: false,
    fields: [...boxes.values()],
  });
  Object.defineProperty(t.agent, "element", { get: button, configurable: true });
  t.agent.health = { features: ["profiles", "exec", "files", "fields", "upload"] };
  t.agent.page = { url: OLX_ADD, title: "OLX", text: "" };
  t.agent.afterAction = (name, input) => {
    if (name === "navigate") {
      boxes.clear();
      t.agent.page = { url: String(input.url), title: "", text: "" };
    }
    if (name === "form_input")
      boxes.set(String((input.target as { ref: string }).ref), String(input.value));
    if (name === "left_click") {
      const host = new URL(t.agent.page.url ?? "").hostname.replace(/^www\./, "");
      t.agent.page = { url: published[host] ?? "", title: TITLE, text: "" };
    }
  };
}

/** One listing task's steps, from the add-listing page to the recorded address. */
const posting = (add: string, price: number, url: string) => [
  { content: [browser("navigate", { url: add })] },
  { content: [toolUse("set_files", {})] },
  { content: [browser("form_input", { target: { type: "ref", ref: "ref_1" }, value: TITLE })] },
  {
    content: [browser("form_input", { target: { type: "ref", ref: "ref_2" }, value: DESCRIPTION })],
  },
  { content: [browser("form_input", { target: { type: "ref", ref: "ref_3" }, value: price })] },
  { content: [browser("left_click", { target: { type: "ref", ref: "ref_9" } })] },
  { content: [toolUse("record_listing", { url })] },
  { content: [toolUse("finish_task", { outcome: "done", summary: "Listed." })] },
];

const clicks = (t: TestApp) => t.agent.browserCalls.filter((c) => c.name === "left_click").length;
const listings = (t: TestApp) =>
  t.db
    .query<{ status: string; draft: string }, []>(
      "SELECT status, draft FROM flip_listings ORDER BY id",
    )
    .all();

test("a flip Scout marks ready is posted on each marketplace in turn without asking, and Scout hears where", async () => {
  const work = new FakeModel([
    ...posting(OLX_ADD, 1199, OLX_URL),
    ...posting("https://www.vinted.pl/items/new", 1249, VINTED_URL),
  ]);
  const t = await testApp(new FakeModel(), work, {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip()]);
  addPage(t, { "olx.pl": OLX_URL, "vinted.pl": VINTED_URL });

  await t.listings.tick();
  await waitFor(() => scout.calls("scout_flip_listed").length === 2);
  await t.tasks.idle();

  expect(scout.calls("scout_flip_listed")).toEqual([
    { flipId: 7, channel: "OLX", status: "listed", url: OLX_URL },
    { flipId: 7, channel: "Vinted", status: "listed", url: VINTED_URL },
  ]);
  const [olx, vinted] = t.tasks.list().sort((a, b) => a.id - b.id);
  expect([olx?.status, vinted?.status]).toEqual(["done", "done"]);
  // Scout's draft is data, and the task that read it is tainted by it.
  expect(olx?.goal).toContain('trusted="false"');
  expect(olx?.tainted).toBe(true);
  // One publish each, and nothing asked: marking it ready was the go-ahead.
  expect(clicks(t)).toBe(2);
  expect(t.approvals.list(false)).toEqual([]);
  expect(t.agent.setFilesCalls.map((c) => c.names)).toEqual([
    ["1.jpg", "2.jpg"],
    ["1.jpg", "2.jpg"],
  ]);
  // Each task's photos are gone once it ends.
  expect(t.agent.staged.size).toBe(0);

  // Scout has it: nothing more is posted.
  await t.listings.tick();
  expect(t.tasks.list()).toHaveLength(2);

  // Marked ready on OLX again after Scout heard: posted again.
  work.script.push(...posting(OLX_ADD, 1199, OLX_URL));
  t.advance(60_000);
  scout.set(scout.flips().map((f) => ({ ...f, channels: { ...f.channels, OLX: "ready" } })));
  await t.listings.tick();
  await waitFor(() => scout.calls("scout_flip_listed").length === 3);
  await t.tasks.idle();
  expect(t.tasks.list().map((x) => x.title)).toContain(`List on OLX: ${TITLE}`);
  await t.plugins.stopAll();
});

test("with the Desktop plugin off, flips aren't listed", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip()]);
  await t.plugins.update("desktop", { enabled: false });
  await t.listings.tick();
  expect(listings(t)).toEqual([]);
  expect(scout.calls("scout_flips_to_list")).toEqual([]);
});

test("a flip changed in Scout before it's posted goes up as it is now, and one taken back posts nothing", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip({ channels: { OLX: "ready" } })]);
  addPage(t, {});
  // The desktop is down, so it waits.
  const status = t.agent.status.bind(t.agent);
  t.agent.status = async () => {
    throw new Error("down");
  };
  await t.listings.tick();
  expect(listings(t).map((r) => r.status)).toEqual(["queued"]);

  scout.set([
    flip({
      updatedAt: "2026-10-09T11:00:00Z",
      prices: { OLX: 999, Vinted: 1249 },
      channels: { OLX: "ready" },
    }),
  ]);
  await t.listings.tick();
  const [now] = listings(t);
  expect(now?.status).toBe("queued");
  expect(JSON.parse(now?.draft ?? "{}").prices.OLX).toBe(999);

  scout.set([flip({ updatedAt: "2026-10-09T11:00:00Z", channels: {} })]);
  await t.listings.tick();
  t.agent.status = status;
  await t.listings.tick();
  expect(listings(t).map((r) => r.status)).toEqual(["cancelled"]);
  expect(t.tasks.list()).toEqual([]);
  await t.plugins.stopAll();
});

test("a listing task types only the approved text, puts photos only on the add-listing page, and publishes once", async () => {
  const work = new FakeModel([
    { content: [toolUse("set_files", {})] },
    { content: [browser("navigate", { url: "https://www.google.com/" })] },
    { content: [browser("navigate", { url: OLX_ADD })] },
    { content: [toolUse("set_files", { photos: [3] })] },
    { content: [toolUse("set_files", { photos: [2, 1] })] },
    { content: [browser("form_input", { target: { type: "ref", ref: "ref_1" }, value: TITLE })] },
    {
      content: [
        browser("form_input", { target: { type: "ref", ref: "ref_7" }, value: 48600600600 }),
      ],
    },
    { content: [browser("type", { text: DESCRIPTION })] },
    { content: [browser("form_input", { target: { type: "ref", ref: "ref_3" }, value: "1 199" })] },
    // The description isn't in yet.
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_9" } })] },
    {
      content: [
        browser("form_input", { target: { type: "ref", ref: "ref_2" }, value: DESCRIPTION }),
      ],
    },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_9" } })] },
    { content: [browser("navigate", { url: OLX_ADD })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_9" } })] },
    { content: [toolUse("record_listing", { url: OLX_ADD })] },
    { content: [toolUse("record_listing", { url: OLX_URL })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Listed." })] },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip({ channels: { OLX: "ready" } })]);
  addPage(t, { "olx.pl": OLX_URL });
  t.agent.page = { url: "https://www.olx.pl/", title: "OLX", text: "" };
  await t.listings.tick();
  await waitFor(() => scout.calls("scout_flip_listed").length === 1);
  await t.tasks.idle();

  const said = (i: number) => JSON.stringify(work.requests[i]?.messages.at(-1));
  expect(said(1)).toContain("add-listing page");
  expect(said(2)).toContain("stays on olx.pl");
  expect(said(4)).toContain("There are 2 photos");
  expect(said(7)).toContain("phone numbers");
  expect(said(8)).toContain("form_input");
  expect(said(10)).toContain("approved description");
  expect(said(12)).toContain("record_listing");
  expect(said(14)).toContain("published once");
  expect(said(15)).toContain("add-listing page, not");
  expect(t.agent.setFilesCalls.map((c) => c.names)).toEqual([["2.jpg", "1.jpg"]]);
  expect(clicks(t)).toBe(1);
  expect(t.agent.browserCalls.map((c) => c.input.value).filter(Boolean)).toEqual([
    TITLE,
    "1 199",
    DESCRIPTION,
  ]);
  expect(scout.calls("scout_flip_listed")).toEqual([
    { flipId: 7, channel: "OLX", status: "listed", url: OLX_URL },
  ]);
  await t.plugins.stopAll();
});

const gateFor = (over: Partial<ListingGate> = {}): ListingGate => ({
  channel: "OLX",
  host: "olx.pl",
  addUrl: OLX_ADD,
  title: TITLE,
  description: DESCRIPTION,
  price: 1199,
  choices: [],
  photos: 2,
  stage: "",
  published: false,
  ...over,
});
const formButton = (label: string, over: Partial<AgentElement> = {}): AgentElement => ({
  tag: "button",
  role: null,
  type: "submit",
  label,
  inForm: true,
  url: OLX_ADD,
  editable: false,
  fields: [TITLE],
  ...over,
});

test("on its add-listing page, a listing task fills in the form without asking, but for what may cost money", () => {
  const g = gateFor();
  const fill = { action: "fill" } as const;
  const usual = { action: "usual" } as const;
  expect(listingCheck(g, "click", formButton("Dalej"), { label: "Dalej" })).toEqual(fill);
  expect(listingCheck(g, "click", formButton(""), { unlabelled: "button" })).toEqual(fill);
  const promote = formButton("Wyróżnij ogłoszenie");
  expect(listingCheck(g, "click", promote, { label: promote.label })).toEqual(usual);
  expect(listingCheck(g, "click", formButton("Dalej"), { frame: "" })).toEqual(usual);
  expect(listingCheck(g, "click", formButton("Dalej"), { unseen: true })).toEqual(usual);
  const elsewhere = formButton("Dalej", { url: OLX_URL });
  expect(listingCheck(g, "click", elsewhere, { label: "Dalej" })).toEqual(usual);
  // A drag reorders photos; a right click opens a menu.
  expect(listingRefused(g, "left_click_drag", {})).toBeNull();
  expect(listingRefused(g, "right_click", {})).toContain("left_click");
});

test("a description longer than what desktop-agent sends of a box still publishes", () => {
  const long = Array.from({ length: 900 }, (_, i) => `Zdanie ${i}.`).join(" ");
  const shown = long.slice(0, 4000);
  const publish = formButton("Dodaj ogłoszenie", { fields: [TITLE, shown, "1199"] });
  expect(listingCheck(gateFor({ description: long }), "click", publish, null)).toEqual({
    action: "publish",
  });
  const cut = formButton("Dodaj ogłoszenie", { fields: [TITLE, shown.slice(0, 3000), "1199"] });
  expect(listingCheck(gateFor({ description: long }), "click", cut, null)).toMatchObject({
    action: "hold",
  });
});

test("on its add-listing page, a listing task's Dalej and Enter in a filled box go on without asking, and an Enter that publishes goes through the listing's check", async () => {
  const work = new FakeModel([
    { content: [browser("navigate", { url: OLX_ADD })] },
    { content: [browser("form_input", { target: { type: "ref", ref: "ref_1" }, value: TITLE })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_8" } })] },
    { content: [browser("key", { text: "Return" })] },
    // On the last step, without the description.
    { content: [browser("key", { text: "Return" })] },
    {
      content: [
        browser("form_input", { target: { type: "ref", ref: "ref_2" }, value: DESCRIPTION }),
      ],
    },
    { content: [browser("form_input", { target: { type: "ref", ref: "ref_3" }, value: 1199 })] },
    { content: [browser("key", { text: "Return" })] },
    { content: [toolUse("record_listing", { url: OLX_URL })] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Listed." })] },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip({ channels: { OLX: "ready" } })]);
  addPage(t, { "olx.pl": OLX_URL });
  const boxes = new Map<string, string>();
  let submit = "Dalej";
  let clicked = false;
  const box = (): AgentElement => ({
    tag: "input",
    role: null,
    type: "text",
    label: "Tytuł",
    inForm: true,
    submitLabel: submit,
    url: t.agent.page.url ?? "",
    editable: true,
    fields: [...boxes.values()],
  });
  Object.defineProperty(t.agent, "element", {
    get: (): AgentElement =>
      clicked
        ? box()
        : { ...box(), tag: "button", type: "submit", label: "Dalej", editable: false },
    configurable: true,
  });
  t.agent.afterAction = (name, input) => {
    if (name === "form_input")
      boxes.set(String((input.target as { ref: string }).ref), String(input.value));
    if (name === "left_click") clicked = true;
    if (name === "key" && submit === "Dalej") submit = "Dodaj ogłoszenie";
    else if (name === "key") t.agent.page = { url: OLX_URL, title: TITLE, text: "" };
  };
  await t.listings.tick();
  await waitFor(() => scout.calls("scout_flip_listed").length === 1);
  await t.tasks.idle();

  expect(JSON.stringify(work.requests[5]?.messages.at(-1))).toContain("approved description");
  expect(t.agent.browserCalls.filter((c) => c.name === "left_click")).toHaveLength(1);
  expect(t.agent.browserCalls.filter((c) => c.name === "key")).toHaveLength(2);
  expect(t.approvals.list(false)).toEqual([]);
  expect(scout.calls("scout_flip_listed")).toEqual([
    { flipId: 7, channel: "OLX", status: "listed", url: OLX_URL },
  ]);
  await t.plugins.stopAll();
});

test("a listing task that published but recorded no address tells Scout it may have gone up", async () => {
  const work = new FakeModel([
    { content: [browser("navigate", { url: OLX_ADD })] },
    { content: [browser("form_input", { target: { type: "ref", ref: "ref_1" }, value: TITLE })] },
    {
      content: [
        browser("form_input", { target: { type: "ref", ref: "ref_2" }, value: DESCRIPTION }),
      ],
    },
    { content: [browser("form_input", { target: { type: "ref", ref: "ref_3" }, value: "1199" })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_9" } })] },
    { content: [toolUse("finish_task", { outcome: "failed", summary: "The page hung." })] },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip({ channels: { OLX: "ready" } })]);
  addPage(t, { "olx.pl": OLX_ADD });
  // Opus doesn't take over the failed task.
  t.settings.update({ desktopEscalate: false });
  await t.listings.tick();
  await waitFor(() => scout.calls("scout_flip_listed").length === 1);
  expect(scout.calls("scout_flip_listed")[0]).toMatchObject({ status: "failed" });
  expect(String(scout.calls("scout_flip_listed")[0]?.error)).toContain("may have gone up");
  await t.plugins.stopAll();
});

test("Scout isn't told without asking when its write asks first; the chat says so once", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  // A flip with no photos fails to post, and Scout would hear so.
  const scout = await withScout(t, [flip({ photos: [], channels: { OLX: "ready" } })], "ask");
  addPage(t, {});
  await t.listings.tick();
  await waitFor(() => t.thread.list().some((m) => m.text.includes("Settings → Plugins → MCP")));
  await t.listings.tick();
  expect(scout.calls("scout_flip_listed")).toEqual([]);
  expect(t.thread.list().filter((m) => m.text.includes("Plugins → MCP"))).toHaveLength(1);
  await t.plugins.stopAll();
});

/** Flip 7, sold on Vinted, and up on OLX and Vinted where Hatbot posted it. Nothing left to post. */
const sold = (over: Partial<Flip> = {}) =>
  flip({
    channels: {},
    soldOn: "2026-10-20",
    saleChannel: "Vinted",
    listed: [
      { channel: "OLX", status: "listed", url: OLX_URL },
      { channel: "Vinted", status: "listed", url: VINTED_URL },
    ],
    ...over,
  });

/** The listing's own page, with the seller's "Zakończ" (ref_5), which ends it. */
function listingPage(t: TestApp) {
  t.agent.health = { features: ["profiles", "exec", "files", "fields", "upload"] };
  t.agent.page = { url: "https://www.olx.pl/", title: "OLX", text: "" };
  Object.defineProperty(t.agent, "element", {
    get: (): AgentElement => ({
      tag: "button",
      role: null,
      type: "button",
      label: "Zakończ",
      inForm: false,
      url: t.agent.page.url ?? "",
      editable: false,
      fields: [],
    }),
    configurable: true,
  });
  t.agent.afterAction = (name, input) => {
    if (name === "navigate") t.agent.page = { url: String(input.url), title: TITLE, text: "" };
  };
}

const takeDowns = (t: TestApp) =>
  t.db
    .query<{ channel: string; status: string }, []>(
      "SELECT channel, status FROM flip_takedowns ORDER BY id",
    )
    .all();

test("a sold flip's listing comes down on the other marketplace without asking, and Scout ticks it", async () => {
  const work = new FakeModel([
    { content: [browser("navigate", { url: OLX_URL })] },
    { content: [browser("left_click", { target: { type: "ref", ref: "ref_5" } })] },
    { content: [toolUse("record_taken_down", {})] },
    { content: [toolUse("finish_task", { outcome: "done", summary: "Ended." })] },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [mcpPlugin], {});
  const scout = await withScout(t, [sold()]);
  listingPage(t);

  await t.listings.tick();
  await waitFor(() => scout.calls("scout_flip_taken_down").length === 1);
  await t.tasks.idle();

  // Not on Vinted, where it went: the buyer may still be paying there.
  expect(scout.calls("scout_flip_taken_down")).toEqual([{ flipId: 7, channel: "OLX" }]);
  expect(scout.flips()[0]?.delisted).toEqual(["OLX"]);
  const [task] = t.tasks.list();
  expect(task?.title).toBe(`Take down on OLX: ${TITLE}`);
  expect(task?.status).toBe("done");
  expect(task?.goal).toContain(OLX_URL);
  expect(task?.goal).toContain('trusted="false"');
  expect(task?.tainted).toBe(true);
  expect(clicks(t)).toBe(1);
  expect(t.approvals.list(false)).toEqual([]);
  expect(takeDowns(t)).toEqual([{ channel: "OLX", status: "down" }]);
  // Only its own tool: it has nothing to post.
  const tools = (work.requests[0]?.tools ?? []).map((x) => ("name" in x ? x.name : ""));
  expect(tools).toContain("record_taken_down");
  expect(tools).not.toContain("record_listing");

  // Scout has it: nothing more comes down.
  await t.listings.tick();
  expect(t.tasks.list()).toHaveLength(1);
  await t.plugins.stopAll();
});

test("a take-down task stays on the marketplace and posts nothing, and one that can't is left to the owner", async () => {
  const work = new FakeModel([
    { content: [browser("navigate", { url: "https://www.google.com/" })] },
    { content: [browser("navigate", { url: OLX_ADD })] },
    { content: [browser("type", { text: "Zadzwoń 600 600 600" })] },
    { content: [toolUse("record_listing", { url: OLX_URL })] },
    { content: [browser("navigate", { url: OLX_URL })] },
    { content: [toolUse("finish_task", { outcome: "failed", summary: "There's no Zakończ." })] },
  ]);
  const t = await testApp(new FakeModel(), work, {}, [mcpPlugin], {});
  const scout = await withScout(t, [sold()]);
  listingPage(t);
  t.settings.update({ desktopEscalate: false });
  await t.listings.tick();
  await waitFor(() => t.thread.list().some((m) => m.text.includes("Take it down yourself")));
  await t.tasks.idle();

  const said = (i: number) => JSON.stringify(work.requests[i]?.messages.at(-1));
  expect(said(1)).toContain("stays on olx.pl");
  expect(said(2)).toContain("posts nothing");
  expect(said(3)).toContain("phone numbers");
  expect(t.agent.browserCalls.map((c) => c.input.url ?? c.input.text)).toEqual([OLX_URL]);
  expect(scout.calls("scout_flip_taken_down")).toEqual([]);
  expect(takeDowns(t)).toEqual([{ channel: "OLX", status: "failed" }]);
  expect(t.thread.list().find((m) => m.text.includes("yourself"))?.text).toContain(
    "There's no Zakończ.",
  );

  // A failure waits for the owner: it isn't tried again on its own.
  t.advance(60_000);
  await t.listings.tick();
  expect(t.tasks.list()).toHaveLength(1);
  await t.plugins.stopAll();
});

test("a listing the owner ticks in Scout first, or a sale taken back, isn't taken down", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, [sold({ saleChannel: "Other" })]);
  listingPage(t);
  // The desktop is down, so they wait.
  const status = t.agent.status.bind(t.agent);
  t.agent.status = async () => {
    throw new Error("down");
  };
  await t.listings.tick();
  expect(takeDowns(t)).toEqual([
    { channel: "OLX", status: "queued" },
    { channel: "Vinted", status: "queued" },
  ]);
  scout.set([sold({ saleChannel: "Other", delisted: ["OLX"] })]);
  await t.listings.tick();
  scout.set([sold({ soldOn: undefined, saleChannel: undefined })]);
  t.agent.status = status;
  await t.listings.tick();
  expect(takeDowns(t)).toEqual([
    { channel: "OLX", status: "cancelled" },
    { channel: "Vinted", status: "cancelled" },
  ]);
  expect(t.tasks.list()).toEqual([]);
  await t.plugins.stopAll();
});

test("a take-down task's gate", () => {
  const g: TakeDownGate = { channel: "OLX", host: "olx.pl", url: OLX_URL, title: TITLE };
  expect(takeDownRefused(g, "navigate", { url: "www.olx.pl/mojolx/ogloszenia" })).toBeNull();
  expect(takeDownRefused(g, "navigate", { url: "back" })).toBeNull();
  expect(takeDownRefused(g, "navigate", { url: "olx.pl.evil.example" })).toContain("stays on");
  expect(takeDownRefused(g, "navigate", { url: "olx.pl/d/adding" })).toContain("posts nothing");
  expect(takeDownRefused(g, "key", { text: "ctrl+l" })).toContain("stays on");
  expect(takeDownRefused(g, "type", { text: TITLE })).toBeNull();
  expect(takeDownRefused(g, "type", { text: "Sprzedałem gdzie indziej" })).toBeNull();
  expect(takeDownRefused(g, "type", { text: "x".repeat(61) })).toContain("short");
  expect(takeDownRefused(g, "type", { text: "kup na allegro.pl" })).toContain("links");
  expect(takeDownRefused(g, "left_click_drag", {})).toContain("left_click");
  expect(takeDownCheck(formButton("Dodaj ogłoszenie"), null)).toContain("posts nothing");
  expect(takeDownCheck(formButton("Zakończ", { url: OLX_URL }), OLX_ADD)).toBeNull();
});
