// Listing Scout's flips: asked once, posted on each marketplace in its own desktop task, Scout told
// where each went; against a stand-in Scout and a stand-in desktop.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpPlugin } from "@hatbot/plugin-mcp";
import type { Approval } from "@hatbot/shared";
import type { AgentElement } from "@hatbot/shared/desktop";
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
const pendingListing = (t: TestApp) =>
  t.approvals.list(true).filter((a) => a.kind === "listing") as Approval[];

test("a flip Scout marks ready is asked about once, posted on each marketplace in turn, and Scout hears where", async () => {
  const work = new FakeModel([
    ...posting(OLX_ADD, 1199, OLX_URL),
    ...posting("https://www.vinted.pl/items/new", 1249, VINTED_URL),
  ]);
  const t = await testApp(new FakeModel(), work, {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip()]);
  addPage(t, { "olx.pl": OLX_URL, "vinted.pl": VINTED_URL });

  await t.listings.tick();
  await t.listings.tick();
  const [approval, ...more] = pendingListing(t);
  expect(more).toEqual([]);
  expect(approval?.summary).toContain("OLX for 1,199 zł and Vinted for 1,249 zł");
  expect(approval?.conversationId).toBe(t.thread.conversationId);
  expect(t.tasks.list()).toEqual([]);

  t.approvals.decide(approval?.id as number, "approve", "web");
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
  // One publish each, and nothing else asked: the listing itself was approved.
  expect(clicks(t)).toBe(2);
  expect(t.approvals.list(false).map((a) => a.kind)).toEqual(["listing"]);
  expect(t.agent.setFilesCalls.map((c) => c.names)).toEqual([
    ["1.jpg", "2.jpg"],
    ["1.jpg", "2.jpg"],
  ]);
  // Each task's photos are gone once it ends.
  expect(t.agent.staged.size).toBe(0);

  // Scout has it: nothing more is asked.
  await t.listings.tick();
  expect(pendingListing(t)).toEqual([]);

  // Marked ready on OLX again after Scout heard: asked again.
  t.advance(60_000);
  scout.set(scout.flips().map((f) => ({ ...f, channels: { ...f.channels, OLX: "ready" } })));
  await t.listings.tick();
  expect(pendingListing(t).map((a) => a.summary)).toEqual([
    `List “${TITLE}” on OLX for 1,199 zł? 2 photos.`,
  ]);
  await t.plugins.stopAll();
});

test("with the Desktop plugin off, flips aren't asked about", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip()]);
  await t.plugins.update("desktop", { enabled: false });
  await t.listings.tick();
  expect(pendingListing(t)).toEqual([]);
  expect(scout.calls("scout_flips_to_list")).toEqual([]);
});

test("a flip changed in Scout is asked about again, one taken back posts nothing, and a no tells Scout", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip()]);
  addPage(t, {});
  await t.listings.tick();
  const first = pendingListing(t)[0] as Approval;

  // The price changed while it waited: the old approval goes and the new one has the new price.
  scout.set([flip({ updatedAt: "2026-10-09T11:00:00Z", prices: { OLX: 999, Vinted: 1249 } })]);
  await t.listings.tick();
  expect(t.approvals.get(first.id)?.status).toBe("cancelled");
  const second = pendingListing(t)[0] as Approval;
  expect(second.summary).toContain("OLX for 999 zł");

  // Approved while the desktop is down, then taken back in Scout before its task started.
  const status = t.agent.status.bind(t.agent);
  t.agent.status = async () => {
    throw new Error("down");
  };
  t.approvals.decide(second.id, "approve", "web");
  const taken = flip({ updatedAt: "2026-10-09T11:00:00Z", channels: {} });
  scout.set([taken]);
  await t.listings.tick();
  t.agent.status = status;
  await t.listings.tick();
  expect(t.tasks.list()).toEqual([]);

  // Denied: Scout hears it was declined.
  scout.set([taken, flip({ id: 8, channels: { Vinted: "ready" } })]);
  await t.listings.tick();
  const third = pendingListing(t).find((a) => a.summary.includes("Vinted")) as Approval;
  t.approvals.decide(third.id, "deny", "web");
  await waitFor(() => scout.calls("scout_flip_listed").length === 1);
  expect(scout.calls("scout_flip_listed")).toEqual([
    { flipId: 8, channel: "Vinted", status: "declined" },
  ]);
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
  t.approvals.decide((pendingListing(t)[0] as Approval).id, "approve", "web");
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
  t.approvals.decide((pendingListing(t)[0] as Approval).id, "approve", "web");
  await waitFor(() => scout.calls("scout_flip_listed").length === 1);
  expect(scout.calls("scout_flip_listed")[0]).toMatchObject({ status: "failed" });
  expect(String(scout.calls("scout_flip_listed")[0]?.error)).toContain("may have gone up");
  await t.plugins.stopAll();
});

test("Scout isn't told without asking when its write asks first; the chat says so once", async () => {
  const t = await testApp(new FakeModel(), new FakeModel(), {}, [mcpPlugin], {});
  const scout = await withScout(t, [flip({ channels: { OLX: "ready" } })], "ask");
  await t.listings.tick();
  t.approvals.decide((pendingListing(t)[0] as Approval).id, "deny", "web");
  await waitFor(() => t.thread.list().some((m) => m.text.includes("Settings → Plugins → MCP")));
  await t.listings.tick();
  expect(scout.calls("scout_flip_listed")).toEqual([]);
  expect(t.thread.list().filter((m) => m.text.includes("Plugins → MCP"))).toHaveLength(1);
  await t.plugins.stopAll();
});
