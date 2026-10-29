import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Heartbeat,
  Schedules,
  Triggers,
  Watchers,
  WeeklyReport,
} from "@hatbot/plugin-automation";
import type { Boxes } from "@hatbot/plugin-boxes";
import type { DesktopService, Teach } from "@hatbot/plugin-desktop";
import { Proxmox } from "@hatbot/plugin-proxmox/client";
import type { Notification, Notifier, Plugin } from "@hatbot/plugin-sdk";
import { SEND_WINDOW_MS } from "../src/approvals";
import { stepOf, totpAt } from "../src/auth/totp";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { EventBus, type HatbotEvent } from "../src/events";
import { MemoryStore } from "../src/memory/store";
import { Secrets } from "../src/secrets";
import { createServices, type Outside } from "../src/services";
import { FakeDesktop } from "./fake-desktop";
import { FakeHatbox } from "./fake-hatbox";
import { FakeModel } from "./fake-model";

class FakeNotifier implements Notifier {
  sent: Notification[] = [];
  async send(n: Notification) {
    this.sent.push(n);
  }
}

export const ORIGIN = "https://hatbot.test";

/** Removed after the run by test/cleanup.ts. */
export const tempDirs: string[] = [];
/** Their page polls are stopped after each test file by test/cleanup.ts. */
export const tempTeach: Teach[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};

/**
 * A migrated database and a memory repo set up on it, made once and copied for each test app:
 * migrating and `git init` are most of what a test app takes to make.
 */
let template: Promise<{ db: Uint8Array; memoryDir: string }> | undefined;
async function makeTemplate() {
  const db = openDb(":memory:");
  const memoryDir = join(tempDir("hatbot-test-template-"), "memory");
  await new MemoryStore(memoryDir, db, new EventBus()).init();
  return { db: db.serialize(), memoryDir };
}
async function fromTemplate(memoryDir: string) {
  template ??= makeTemplate();
  const t = await template;
  cpSync(t.memoryDir, memoryDir, { recursive: true });
  const db = Database.deserialize(t.db, { strict: true });
  // What openDb sets on its connection that matters in memory.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA secure_delete = ON");
  return db;
}

/** `model` answers the chat thread; `taskModel` answers desktop tasks. */
export async function testApp(
  model = new FakeModel(),
  taskModel = new FakeModel(),
  proxmoxEnv: Record<string, string> = {},
  pluginList: Plugin[] = [],
  pluginEnv: Record<string, string> = {},
  more: Partial<Outside> = {},
) {
  let nowMs = Date.parse("2026-10-09T12:00:00Z");
  /** What the brain's own requests elsewhere get, such as T3 Code's sign-in. */
  const outside = {
    fetch: async (_url: string, _init?: RequestInit) => new Response(null, { status: 404 }),
  };
  const clock = () => nowMs;
  const dir = tempDir("hatbot-test-");
  const updateDir = join(dir, "update");
  const config = {
    ...loadConfig({ HATBOT_PUBLIC_URL: ORIGIN, HATBOT_DATA_DIR: "/nonexistent" }),
    dataDir: dir,
    memoryDir: join(dir, "memory"),
    archiveDir: join(dir, "archive"),
    updateDir,
    updateRequest: join(updateDir, "request"),
    releaseFile: join(updateDir, "release.json"),
  };
  mkdirSync(config.archiveDir);
  mkdirSync(updateDir);
  const db = await fromTemplate(config.memoryDir);
  const agent = new FakeDesktop();
  const hatbox = new FakeHatbox();
  const sent = new FakeNotifier();
  const proxmox = new Proxmox(proxmoxEnv);
  proxmox.pollMs = 5;
  let restarts = 0;
  const s = await createServices({
    config,
    db,
    clock,
    model,
    taskModel,
    agent,
    hatbox,
    notifications: sent,
    ntfy: null,
    proxmox,
    plugins: pluginList,
    pluginEnv,
    secrets: new Secrets(join(dir, "secrets.json"), {}),
    // Argon2id at its lowest cost: the brain's own takes ~75 ms a hash, on every sign-in.
    passwordCost: { memoryCost: 8, timeCost: 1 },
    fetch: async (url, init) =>
      url === `${ORIGIN}/api/v1/health` ? Response.json({ ok: true }) : outside.fetch(url, init),
    restart: () => {
      restarts++;
    },
    ...more,
  });
  const service = <T>(name: string) => {
    const found = s.plugins.service<T>(name);
    if (!found) throw new Error(`No plugin that's on gives "${name}".`);
    return found;
  };
  const seen: HatbotEvent[] = [];
  s.events.on((e) => seen.push(e));
  await s.plugins.startAll();
  tempTeach.push(service<DesktopService>("desktop").teach);

  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    s.app.request(`/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    ...s,
    model,
    taskModel,
    agent,
    hatbox,
    outside,
    notifier: sent,
    thread: s.chats.hatbot(),
    updateDir,
    events: seen,
    call,
    advance: (ms: number) => {
      nowMs += ms;
    },
    code: (secret: string) => totpAt(secret, stepOf(nowMs)),
    /** How often the brain asked to start again. */
    get restarts() {
      return restarts;
    },
    get schedules() {
      return service<Schedules>("schedules");
    },
    get triggers() {
      return service<Triggers>("triggers");
    },
    get watchers() {
      return service<Watchers>("watchers");
    },
    get heartbeat() {
      return service<Heartbeat>("heartbeat");
    },
    get report() {
      return service<WeeklyReport>("report");
    },
    get boxes() {
      return service<Boxes>("boxes");
    },
    /** Who has the desktop. */
    get desktop() {
      return service<DesktopService>("desktop").control;
    },
    get teach() {
      return service<DesktopService>("desktop").teach;
    },
    /** The one screen tasks and Teach take turns at. */
    get lane() {
      return service<DesktopService>("desktop").lane;
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof testApp>>;

export async function setUpOwner(t: TestApp, password = "correct horse battery") {
  const start = await t.call("POST", "/auth/setup/start", { code: t.auth.setupCode });
  const { secret } = (await start.json()) as { secret: string };
  const res = await t.call("POST", "/auth/setup", {
    code: t.auth.setupCode,
    password,
    totp: t.code(secret),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  t.advance(30_000); // the setup code's TOTP step is now used
  return { secret, password, cookie };
}

/** A signed-in session, without hashing a password the way setUpOwner does. */
export const signIn = (t: TestApp) => ({ cookie: `hatbot_session=${t.auth.createSession(null)}` });

/** Polls until `fn` returns something truthy (async task runs). */
/** Waits for a message to a person to start its window, then lets the window pass. */
export async function letSend(t: TestApp) {
  const a = await waitFor(() => t.approvals.list(true).find((a) => a.status === "sending"));
  t.advance(SEND_WINDOW_MS);
  t.approvals.expireDue();
  return a;
}

export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

export const bot = (t: TestApp, name: string) =>
  t.bots.create({ name, instructions: "", chatModel: null, chatEffort: null, plugins: null });

export const lastUserText = (req: { messages: { content: unknown }[] } | undefined) =>
  JSON.stringify(req?.messages.at(-1)?.content);

export const toolNames = (req: { tools?: unknown[] } | undefined) =>
  (req?.tools ?? []).flatMap((x) => (x && typeof x === "object" && "name" in x ? [x.name] : []));

/** Turns as sent, but for where each request marks the cache. */
export const unmarked = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));

/** Resolves once `model` has been sent `n` requests in all. */
export function requested(model: FakeModel, n = 1): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const route = model.route;
  model.route = (p) => {
    if (model.requests.length >= n) resolve();
    return route?.(p);
  };
  return promise;
}
