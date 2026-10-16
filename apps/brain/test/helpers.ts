import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chats } from "../src/agent/chats";
import { CORE_TOOL_NAMES } from "../src/agent/tools";
import { createApp } from "../src/app";
import { Approvals } from "../src/approvals";
import { Archive } from "../src/archive";
import { Attachments } from "../src/attachments";
import { AuthService, FailureLimiter } from "../src/auth/service";
import { stepOf, totpAt } from "../src/auth/totp";
import { Bots } from "../src/bots";
import { Checks } from "../src/checks";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Desktop } from "../src/desktop/service";
import { EventBus, type HatbotEvent } from "../src/events";
import { Heartbeat } from "../src/heartbeat";
import { Proposals } from "../src/memory/proposals";
import { MemoryStore } from "../src/memory/store";
import { Negotiations } from "../src/negotiate/service";
import { LinkingNotifier, type Notification, type Notifier } from "../src/notify";
import { codePlugin } from "../src/plugins/code";
import type { Plugin } from "../src/plugins/plugin";
import { Plugins } from "../src/plugins/registry";
import { Proxmox } from "../src/proxmox";
import { WeeklyReport } from "../src/report";
import { Schedules } from "../src/schedules";
import { SettingsStore } from "../src/settings";
import { Spend } from "../src/spend";
import { Storage } from "../src/storage";
import { Tasks } from "../src/tasks/service";
import { Teach } from "../src/teach/service";
import { Skills } from "../src/teach/skills";
import { Triggers } from "../src/triggers";
import { Updates } from "../src/updates";
import { Watchers } from "../src/watch/service";
import { FakeDesktop } from "./fake-desktop";
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

/** `model` answers the chat thread; `taskModel` answers desktop tasks and screening. */
export async function testApp(
  model = new FakeModel(),
  taskModel = new FakeModel(),
  proxmoxEnv: Record<string, string> = {},
  pluginList: Plugin[] = [],
  pluginEnv: Record<string, string> = {},
) {
  let nowMs = Date.parse("2026-10-09T12:00:00Z");
  const clock = () => nowMs;
  const config = loadConfig({ HATBOT_PUBLIC_URL: ORIGIN, HATBOT_DATA_DIR: "/nonexistent" });
  const db = openDb(":memory:");
  const auth = new AuthService(db, clock);
  const loginLimits = {
    perIp: new FailureLimiter(10, 15 * 60_000, clock),
    global: new FailureLimiter(50, 15 * 60_000, clock),
  };
  const events = new EventBus();
  const seen: HatbotEvent[] = [];
  events.on((e) => seen.push(e));
  const settings = new SettingsStore(db);
  const spend = new Spend(db, settings, events, clock);
  const memory = new MemoryStore(tempDir("hatbot-test-mem-"));
  await memory.init();
  const skills = new Skills(db, memory, clock);
  skills.watch(events);
  const archive = new Archive(tempDir("hatbot-test-archive-"), clock);
  const attachments = new Attachments({ db, archive, events }, clock);
  const storage = new Storage({ db, archive, clock });
  const agent = new FakeDesktop();
  const desktop = new Desktop(agent, events, db);
  const plugins = new Plugins([...pluginList, codePlugin({ desktop: agent, attachments })], {
    db,
    events,
    env: pluginEnv,
    files: { desktop: agent, attachments },
    reserved: CORE_TOOL_NAMES,
  });
  await plugins.startAll();
  const bots = new Bots(db, events, clock);
  const chats = new Chats({ db, memory, events, spend, settings, model, plugins, bots, clock });
  taskModel.onCreate ??= () => '{"suspected": false, "excerpt": ""}';
  const sent = new FakeNotifier();
  const notifier = new LinkingNotifier(sent, ORIGIN, () => settings.get().notificationsOpen);
  const approvals = new Approvals(db, events, notifier, ORIGIN, clock, bots);
  const tasks = new Tasks({
    db,
    events,
    spend,
    settings,
    model: taskModel,
    desktop,
    approvals,
    notifier,
    archive,
    attachments,
    chats,
    bots,
    config,
    memory,
    plugins,
    skills,
    clock,
  });
  const teach = new Teach({
    db,
    events,
    desktop,
    lane: tasks.lane,
    archive,
    model: taskModel,
    spend,
    settings,
    skills,
    clock,
  });
  tempTeach.push(teach);
  const schedules = new Schedules(db, events, settings, tasks, clock);
  const triggers = new Triggers(db, events, settings, tasks, notifier, ORIGIN, clock);
  const watchers = new Watchers({
    db,
    events,
    settings,
    tasks,
    chats,
    notifier,
    desktop: agent,
    plugins,
    bots,
    publicUrl: ORIGIN,
    clock,
  });
  const heartbeat = new Heartbeat({
    db,
    events,
    settings,
    spend,
    model: taskModel,
    tasks,
    chats,
    notifier,
    plugins,
    desktop,
    bots,
    publicUrl: ORIGIN,
    clock,
  });
  const proposals = new Proposals({
    db,
    events,
    settings,
    spend,
    model: taskModel,
    memory,
    skills,
    tasks,
    notifier,
    publicUrl: ORIGIN,
    clock,
  });
  const report = new WeeklyReport({
    db,
    settings,
    chats,
    notifier,
    bots,
    memory,
    storage,
    publicUrl: ORIGIN,
    clock,
  });
  const negotiations = new Negotiations({
    db,
    events,
    tasks,
    approvals,
    chats,
    bots,
    memory,
    desktop,
    clock,
  });
  tasks.negotiations = negotiations;
  chats.attach({
    tasks,
    schedules,
    triggers,
    watchers,
    approvals,
    attachments,
    desktop: agent,
    negotiations,
  });
  const updateDir = tempDir("hatbot-test-update-");
  const updates = new Updates(
    {
      updateDir,
      updateRequest: join(updateDir, "request"),
      releaseFile: join(updateDir, "release.json"),
    },
    clock,
  );
  const proxmox = new Proxmox(proxmoxEnv);
  proxmox.pollMs = 5;
  const checks = new Checks({
    db,
    config,
    settings,
    spend,
    model: taskModel,
    memory,
    archive,
    storage,
    desktop,
    plugins,
    approvals,
    proxmox,
    updates,
    ntfy: null,
    fetch: async (url) =>
      url === `${ORIGIN}/api/v1/health`
        ? Response.json({ ok: true })
        : new Response(null, { status: 404 }),
    clock,
  });
  const app = createApp({
    config,
    db,
    auth,
    loginLimits,
    events,
    settings,
    spend,
    memory,
    chats,
    bots,
    tasks,
    approvals,
    desktop,
    archive,
    attachments,
    proxmox,
    updates,
    schedules,
    triggers,
    watchers,
    heartbeat,
    report,
    proposals,
    plugins,
    teach,
    checks,
    negotiations,
  });

  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    app,
    db,
    auth,
    memory,
    model,
    taskModel,
    settings,
    tasks,
    approvals,
    desktop,
    agent,
    archive,
    attachments,
    notifier: sent,
    spend,
    /** Hatbot's own chat. */
    thread: chats.hatbot(),
    chats,
    bots,
    schedules,
    triggers,
    watchers,
    negotiations,
    heartbeat,
    report,
    proposals,
    plugins,
    skills,
    teach,
    checks,
    storage,
    updateDir,
    events: seen,
    call,
    advance: (ms: number) => {
      nowMs += ms;
    },
    code: (secret: string) => totpAt(secret, stepOf(nowMs)),
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

/** Polls until `fn` returns something truthy (async task runs). */
export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}
