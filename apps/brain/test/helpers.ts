import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Thread } from "../src/agent/thread";
import { createApp } from "../src/app";
import { Approvals } from "../src/approvals";
import { Archive } from "../src/archive";
import { AuthService, FailureLimiter } from "../src/auth/service";
import { stepOf, totpAt } from "../src/auth/totp";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Desktop } from "../src/desktop/service";
import { EventBus, type HatbotEvent } from "../src/events";
import { MemoryStore } from "../src/memory/store";
import type { Notification, Notifier } from "../src/notify";
import { SettingsStore } from "../src/settings";
import { Spend } from "../src/spend";
import { Tasks } from "../src/tasks/service";
import { FakeDesktop } from "./fake-desktop";
import { FakeModel } from "./fake-model";

class FakeNotifier implements Notifier {
  sent: Notification[] = [];
  async send(n: Notification) {
    this.sent.push(n);
  }
}

export const ORIGIN = "https://hatbot.test";

/** `model` answers the chat thread; `taskModel` answers desktop tasks and screening. */
export async function testApp(model = new FakeModel(), taskModel = new FakeModel()) {
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
  const memory = new MemoryStore(mkdtempSync(join(tmpdir(), "hatbot-test-mem-")));
  await memory.init();
  const thread = new Thread({ db, memory, events, spend, settings, model, clock });
  taskModel.onCreate ??= () => '{"suspected": false, "excerpt": ""}';
  const notifier = new FakeNotifier();
  const archive = new Archive(mkdtempSync(join(tmpdir(), "hatbot-test-archive-")), clock);
  const agent = new FakeDesktop();
  const desktop = new Desktop(agent, events);
  const approvals = new Approvals(db, events, notifier, ORIGIN, clock);
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
    thread,
    config,
    clock,
  });
  thread.attachTasks(tasks);
  const app = createApp({
    config,
    db,
    auth,
    loginLimits,
    events,
    settings,
    spend,
    memory,
    thread,
    tasks,
    approvals,
    desktop,
    archive,
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
    notifier,
    spend,
    thread,
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
