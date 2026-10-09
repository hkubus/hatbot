import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Thread } from "../src/agent/thread";
import { createApp } from "../src/app";
import { AuthService, FailureLimiter } from "../src/auth/service";
import { stepOf, totpAt } from "../src/auth/totp";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { EventBus, type HatbotEvent } from "../src/events";
import { MemoryStore } from "../src/memory/store";
import { SettingsStore } from "../src/settings";
import { Spend } from "../src/spend";
import { FakeModel } from "./fake-model";

export const ORIGIN = "https://hatbot.test";

export async function testApp(model = new FakeModel()) {
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
  const app = createApp({ config, db, auth, loginLimits, events, settings, spend, memory, thread });

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
    settings,
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
