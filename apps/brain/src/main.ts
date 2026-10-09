import { websocket } from "hono/bun";
import { AnthropicModelClient } from "./agent/model";
import { Thread } from "./agent/thread";
import { createApp } from "./app";
import { Approvals } from "./approvals";
import { Archive } from "./archive";
import { AuthService, FailureLimiter } from "./auth/service";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { HttpDesktopAgent } from "./desktop/client";
import { Desktop } from "./desktop/service";
import { EventBus } from "./events";
import { MemoryStore } from "./memory/store";
import { NtfyNotifier } from "./notify";
import { Proxmox } from "./proxmox";
import { Schedules } from "./schedules";
import { SettingsStore } from "./settings";
import { Spend } from "./spend";
import { Tasks } from "./tasks/service";
import { Triggers } from "./triggers";
import { Updates } from "./updates";
import { webHandler } from "./web";

const config = loadConfig();
const db = openDb(config.dbPath);
const auth = new AuthService(db);
const events = new EventBus();
const settings = new SettingsStore(db);
const spend = new Spend(db, settings, events);
const memory = new MemoryStore(config.memoryDir);
await memory.init();
const model = new AnthropicModelClient();
const thread = new Thread({ db, memory, events, spend, settings, model });
const notifier = new NtfyNotifier();
const archive = new Archive(config.archiveDir);
const desktop = new Desktop(new HttpDesktopAgent(), events);
const approvals = new Approvals(db, events, notifier, config.publicUrl);
const tasks = new Tasks({
  db,
  events,
  spend,
  settings,
  model,
  desktop,
  approvals,
  notifier,
  archive,
  thread,
  config,
  memory,
});
const schedules = new Schedules(db, events, settings, tasks);
const triggers = new Triggers(db, events, settings, tasks, notifier, config.publicUrl);
thread.attach({ tasks, schedules, triggers });
await desktop.setPaused(settings.get().paused);
await desktop.refresh();
setInterval(() => void desktop.refresh(), 30_000);
setInterval(() => approvals.expireDue(), 60_000);
schedules.tick();
setInterval(() => schedules.tick(), 10_000);
const loginLimits = {
  perIp: new FailureLimiter(10, 15 * 60_000),
  global: new FailureLimiter(50, 15 * 60_000),
};

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
  proxmox: new Proxmox(),
  updates: new Updates(config),
  schedules,
  triggers,
});
const web = webHandler(config.webDir);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: (req, srv) =>
    new URL(req.url).pathname.startsWith("/api/") ? app.fetch(req, srv) : web(req),
  websocket,
});
console.log(`hatbot brain listening on http://${server.hostname}:${server.port}`);
if (!auth.isSetUp()) {
  console.log(`First run: open ${config.publicUrl}/setup and enter setup code ${auth.setupCode}`);
}
if (!process.env.ANTHROPIC_API_KEY)
  console.warn("ANTHROPIC_API_KEY is not set; chat replies will fail");
