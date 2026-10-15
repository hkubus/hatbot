import { websocket } from "hono/bun";
import { Chats } from "./agent/chats";
import { AnthropicModelClient } from "./agent/model";
import { CORE_TOOL_NAMES } from "./agent/tools";
import { createApp } from "./app";
import { Approvals } from "./approvals";
import { Archive } from "./archive";
import { Attachments } from "./attachments";
import { AuthService, FailureLimiter } from "./auth/service";
import { Bots } from "./bots";
import { Checks } from "./checks";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { HttpDesktopAgent } from "./desktop/client";
import { Desktop } from "./desktop/service";
import { EventBus } from "./events";
import { Heartbeat } from "./heartbeat";
import { Proposals } from "./memory/proposals";
import { MemoryStore } from "./memory/store";
import { LinkingNotifier, NtfyNotifier } from "./notify";
import { PLUGINS } from "./plugins";
import { codePlugin } from "./plugins/code";
import { Plugins } from "./plugins/registry";
import { Proxmox } from "./proxmox";
import { WeeklyReport } from "./report";
import { Schedules } from "./schedules";
import { SettingsStore } from "./settings";
import { Spend } from "./spend";
import { Storage } from "./storage";
import { Tasks } from "./tasks/service";
import { Teach } from "./teach/service";
import { Skills } from "./teach/skills";
import { Triggers } from "./triggers";
import { Updates } from "./updates";
import { Watchers } from "./watch/service";
import { webHandler } from "./web";

const config = loadConfig();
const db = openDb(config.dbPath);
const auth = new AuthService(db);
const events = new EventBus();
const settings = new SettingsStore(db);
const spend = new Spend(db, settings, events);
const memory = new MemoryStore(config.memoryDir);
await memory.init();
const skills = new Skills(db, memory);
await skills.refresh();
skills.watch(events);
const model = new AnthropicModelClient();
const archive = new Archive(config.archiveDir);
const storage = new Storage({ db, archive });
const attachments = new Attachments({ db, archive, events });
const desktop = new Desktop(new HttpDesktopAgent(), events, db);
const plugins = new Plugins([...PLUGINS, codePlugin({ desktop: desktop.agent, attachments })], {
  db,
  events,
  files: { desktop: desktop.agent, attachments },
  reserved: CORE_TOOL_NAMES,
});
// In the background: an MCP server that is slow to answer mustn't hold up the health check.
const pluginsStarted = plugins
  .startAll()
  .catch((err) => console.error("plugins failed to start", err));
const bots = new Bots(db, events);
const chats = new Chats({ db, memory, events, spend, settings, model, plugins, bots });
const ntfy = new NtfyNotifier();
const notifier = new LinkingNotifier(
  ntfy,
  config.publicUrl,
  () => settings.get().notificationsOpen,
);
const approvals = new Approvals(db, events, notifier, config.publicUrl, Date.now, bots);
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
  attachments,
  chats,
  bots,
  config,
  memory,
  plugins,
  skills,
});
const teach = new Teach({
  db,
  events,
  desktop,
  lane: tasks.lane,
  archive,
  model,
  spend,
  settings,
  skills,
});
const schedules = new Schedules(db, events, settings, tasks);
const triggers = new Triggers(db, events, settings, tasks, notifier, config.publicUrl);
const watchers = new Watchers({
  db,
  events,
  settings,
  tasks,
  chats,
  notifier,
  desktop: desktop.agent,
  plugins,
  bots,
  publicUrl: config.publicUrl,
});
const heartbeat = new Heartbeat({
  db,
  events,
  settings,
  spend,
  model,
  tasks,
  chats,
  notifier,
  plugins,
  desktop,
  bots,
  publicUrl: config.publicUrl,
});
const proposals = new Proposals({ db, events, settings, spend, model, memory, skills, tasks });
const report = new WeeklyReport({
  db,
  settings,
  chats,
  notifier,
  bots,
  memory,
  storage,
  publicUrl: config.publicUrl,
});
chats.attach({
  tasks,
  schedules,
  triggers,
  watchers,
  approvals,
  attachments,
  desktop: desktop.agent,
});
// A restart ends an incognito conversation.
await chats.endIncognito();
await desktop.setPaused(settings.get().paused);
await desktop.refresh();
setInterval(() => void desktop.refresh(), 30_000);
setInterval(() => approvals.expireDue(), 60_000);
setInterval(() => void chats.sweep(), 60_000);
// Runs missed while the brain was down start once plugins are up, so they get their tools.
void Promise.race([pluginsStarted, Bun.sleep(30_000)]).then(() => {
  schedules.tick();
  triggers.tick();
  watchers.tick();
  setInterval(() => {
    schedules.tick();
    triggers.tick();
    watchers.tick();
    heartbeat.tick();
    report.tick();
    proposals.tick();
    storage.tick();
  }, 10_000);
});
const proxmox = new Proxmox();
const updates = new Updates(config);
const checks = new Checks({
  db,
  config,
  settings,
  spend,
  model,
  memory,
  archive,
  storage,
  desktop,
  plugins,
  approvals,
  proxmox,
  updates,
  ntfy,
  apiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
});
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
