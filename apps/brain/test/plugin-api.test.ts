import { expect, test } from "bun:test";
import {
  definePlugin,
  type Plugin,
  pluginRoutes,
  ready,
  SDK_VERSION,
  tool,
} from "@hatbot/plugin-sdk";
import { z } from "zod";
import { signIn, testApp } from "./helpers";
import { ON_BY_DEFAULT, stopPluginsAfterEach, track } from "./plugin-helpers";

stopPluginsAfterEach();

const plain = (p: Partial<Plugin> & { id: string }): Plugin =>
  definePlugin({
    name: p.id,
    description: "",
    config: z.object({}),
    start: () => ready([]),
    ...p,
  });

const app = async (plugins: Plugin[]) => track(await testApp(undefined, undefined, {}, plugins));

test("a plugin made for another major of the API stays off and says why", async () => {
  const t = await app([plain({ id: "old", sdk: SDK_VERSION + 1, defaultOn: true })]);
  expect(t.plugins.get("old")).toMatchObject({ state: "error" });
  expect(t.plugins.get("old")?.message).toContain("another version");
});

test("an internal plugin is always on, gives every bot its tools, and isn't in Settings", async () => {
  const look = tool({
    name: "look_around",
    description: "Look",
    access: "read",
    schema: z.object({}),
    run: async () => "nothing",
  });
  const t = await app([plain({ id: "core", internal: true, start: () => ready([look]) })]);
  for (const id of ON_BY_DEFAULT) await t.plugins.update(id, { enabled: false });
  expect(t.plugins.list().map((p) => p.id)).not.toContain("core");
  expect(t.plugins.tools([], ["core"]).map((x) => x.name)).toContain("look_around");
  expect(t.plugins.names()).toEqual([]);
  await expect(t.plugins.update("core", { enabled: false })).rejects.toThrow("No plugin");
});

test("a plugin on by default runs until switched off, and stays off", async () => {
  const t = await app([plain({ id: "feature", defaultOn: true })]);
  expect(t.plugins.get("feature")).toMatchObject({ enabled: true, state: "ready" });
  await t.plugins.update("feature", { enabled: false });
  const { Plugins } = await import("../src/plugins/registry");
  const after = new Plugins([plain({ id: "feature", defaultOn: true })], {
    db: t.db,
    events: { emit: () => {} } as never,
    secrets: t.secrets,
    dataDir: t.config.dataDir,
    reserved: [],
  });
  expect(after.get("feature")?.enabled).toBe(false);
});

test("a plugin that needs a service waits for the one that provides it, and follows it", async () => {
  let gave = 0;
  const seen: unknown[] = [];
  const provider = plain({
    id: "giver",
    provides: ["thing"],
    start: () => ready([], { services: { thing: { n: ++gave } } }),
  });
  const user = plain({
    id: "taker",
    needs: ["thing"],
    defaultOn: true,
    start: ({ service }) => {
      seen.push(service("thing"));
      return ready([]);
    },
  });
  const t = await app([user, provider]);
  expect(t.plugins.get("taker")).toMatchObject({ state: "needs_setup" });
  expect(t.plugins.get("taker")?.message).toContain("the giver plugin");

  await t.plugins.update("giver", { enabled: true });
  expect(t.plugins.get("taker")?.state).toBe("ready");
  await t.plugins.update("giver", { config: {} });
  expect(seen).toEqual([{ n: 1 }, { n: 2 }]);

  await t.plugins.update("giver", { enabled: false });
  expect(t.plugins.get("taker")?.state).toBe("needs_setup");
});

test("a plugin's migrations run once each, in order, on its own count", async () => {
  const migrations = [
    "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)",
    "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
  ];
  const t = await app([plain({ id: "notes", migrations })]);
  t.db.query("INSERT INTO notes (text, pinned) VALUES ('hi', 1)").run();
  const { Plugins } = await import("../src/plugins/registry");
  new Plugins(
    [plain({ id: "notes", migrations: [...migrations, "CREATE INDEX x ON notes (text)"] })],
    {
      db: t.db,
      events: { emit: () => {} } as never,
      secrets: t.secrets,
      dataDir: t.config.dataDir,
      reserved: [],
    },
  );
  expect(t.db.query("SELECT text, pinned FROM notes").all()).toEqual([{ text: "hi", pinned: 1 }]);
  expect(t.db.query("SELECT version FROM plugin_migrations WHERE plugin = 'notes'").all()).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
  ]);
});

test("a plugin's routes answer the signed in, its public ones anybody, and none once it's off", async () => {
  const routes = plain({
    id: "pages",
    defaultOn: true,
    routes: ["/pages"],
    publicRoutes: ["/hooks/pages/:name"],
    start: () => {
      const r = pluginRoutes()
        .get("/pages/:id", (c) => c.json({ id: c.req.param("id"), by: c.env.principal?.kind }))
        .post("/hooks/pages/:name", (c) => c.json({ name: c.req.param("name") }));
      return ready([], { routes: r });
    },
  });
  const t = await app([routes]);
  expect((await t.call("GET", "/pages/7")).status).toBe(401);
  const mine = await t.call("GET", "/pages/7", undefined, signIn(t));
  expect(await mine.json()).toEqual({ id: "7", by: "session" });
  expect(await (await t.call("POST", "/hooks/pages/x", {})).json()).toEqual({ name: "x" });

  await t.plugins.update("pages", { enabled: false });
  expect((await t.call("GET", "/pages/7", undefined, signIn(t))).status).toBe(404);
});

test("a plugin keeps small values of its own, and adds lines to the prompt while it's on", async () => {
  let store: { get: (k: string) => string | null; set: (k: string, v: string | null) => void };
  const p = plain({
    id: "keeper",
    defaultOn: true,
    start: (ctx) => {
      store = ctx.store;
      return ready([], { prompt: { chat: "Keep things.", task: "Keep at it." } });
    },
  });
  const t = await app([p]);
  for (const id of ON_BY_DEFAULT) await t.plugins.update(id, { enabled: false });
  // biome-ignore lint/style/noNonNullAssertion: set by start
  const mine = store!;
  mine.set("last", "42");
  expect(mine.get("last")).toBe("42");
  expect(t.db.query("SELECT value FROM settings WHERE key = 'keeper:last'").get()).toEqual({
    value: "42",
  });
  expect(t.plugins.prompt("chat")).toBe("Keep things.");
  await t.plugins.update("keeper", { enabled: false });
  expect(t.plugins.prompt("chat")).toBe("");
});

test("a plugin's tick runs only while it's on", async () => {
  let runs = 0;
  const t = await app([
    plain({
      id: "ticker",
      defaultOn: true,
      start: () => ready([], { ticks: [{ name: "count", everyMs: 60_000, run: () => runs++ }] }),
    }),
  ]);
  await t.plugins.tick("ticker", "count");
  expect(runs).toBe(1);
  await t.plugins.update("ticker", { enabled: false });
  await expect(t.plugins.tick("ticker", "count")).rejects.toThrow();
});

test("a service the core provides counts for a plugin's needs, and no plugin may provide it too", async () => {
  const t = await app([plain({ id: "planner", needs: ["schedules"], defaultOn: true })]);
  expect(t.plugins.get("planner")?.state).toBe("ready");
  const { Plugins } = await import("../src/plugins/registry");
  expect(
    () =>
      new Plugins([plain({ id: "rival", provides: ["schedules"] })], {
        db: t.db,
        events: { emit: () => {} } as never,
        secrets: t.secrets,
        dataDir: t.config.dataDir,
        reserved: [],
        services: { schedules: () => ({}) },
      }),
  ).toThrow("both provide");
});

test("what a plugin emits reaches whoever listens, under its id", async () => {
  let emit: (event: string) => void = () => {};
  const t = await app([
    plain({
      id: "pinger",
      defaultOn: true,
      start: (ctx) => {
        emit = ctx.emit;
        return ready([]);
      },
    }),
  ]);
  const heard: string[] = [];
  t.plugins.on("pinger:connected", () => heard.push("pinger"));
  t.plugins.on("other:connected", () => heard.push("other"));
  emit("connected");
  expect(heard).toEqual(["pinger"]);
});
