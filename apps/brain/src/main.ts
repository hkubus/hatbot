import { join } from "node:path";
import { websocket } from "hono/bun";
import { AnthropicModelClient } from "./agent/model";
import { loadConfig, urlHost } from "./config";
import { openDb } from "./db";
import { HttpDesktopAgent } from "./desktop/client";
import { HttpHatboxAgent } from "./hatbox/client";
import { NtfyNotifier } from "./notify";
import { PLUGINS } from "./plugins";
import { Secrets } from "./secrets";
import { createServices } from "./services";
import { webHandler } from "./web";

const config = loadConfig();
const secrets = new Secrets(join(config.dataDir, "secrets.json"));
const model = new AnthropicModelClient(secrets.apiKey());
const ntfy = new NtfyNotifier(secrets.ntfy());
secrets.onChange(() => {
  model.setApiKey(secrets.apiKey());
  ntfy.configure(secrets.ntfy());
});
const brain = await createServices({
  config,
  db: openDb(config.dbPath),
  model,
  taskModel: model,
  agent: new HttpDesktopAgent(),
  hatbox: new HttpHatboxAgent(),
  notifications: ntfy,
  ntfy,
  plugins: PLUGINS,
  pingUrl: process.env.HATBOT_PING_URL,
  secrets,
});
const { app, auth, approvals, chats, desktop, negotiations, plugins, settings, tasks } = brain;
const { schedules, triggers, watchers, heartbeat, report, proposals, storage, ping } = brain;
await brain.skills.refresh();
// In the background: an MCP server that is slow to answer mustn't hold up the health check.
const pluginsStarted = plugins
  .startAll()
  .catch((err) => console.error("plugins failed to start", err));
// A restart ends an incognito conversation.
await chats.endIncognito();
// Tasks the restart stopped, told where they were started.
tasks.recover();
await desktop.setPaused(settings.get().paused);
await desktop.refresh();
// The last line of defence: a failure nothing waited for is logged, rather than restarting the brain
// and stopping every task in flight.
process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));
/** Each timer's job on its own: one that throws is logged, and the others still run. */
const safely = (name: string, fn: () => unknown) => {
  try {
    const out = fn();
    if (out instanceof Promise) out.catch((err) => console.error(`${name} failed`, err));
  } catch (err) {
    console.error(`${name} failed`, err);
  }
};
setInterval(() => safely("desktop refresh", () => desktop.refresh()), 30_000);
setInterval(() => safely("approvals", () => approvals.expireDue()), 60_000);
setInterval(() => safely("questions", () => brain.questions.expireDue()), 60_000);
setInterval(() => safely("sign-in prune", () => auth.prune()), 3600_000);
setInterval(() => safely("negotiations", () => negotiations.due()), 60_000);
setInterval(() => safely("chat sweep", () => chats.sweep()), 60_000);
setInterval(() => safely("to-do reminders", () => brain.todoReminders.tick()), 60_000);
// Runs missed while the brain was down start once plugins are up, so they get their tools.
void Promise.race([pluginsStarted, Bun.sleep(30_000)]).then(() => {
  safely("schedules", () => schedules.tick());
  safely("triggers", () => triggers.tick());
  safely("watchers", () => watchers.tick());
  setInterval(() => {
    safely("ping", () => ping.tick());
    safely("schedules", () => schedules.tick());
    safely("triggers", () => triggers.tick());
    safely("watchers", () => watchers.tick());
    safely("heartbeat", () => heartbeat.tick());
    safely("weekly report", () => report.tick());
    safely("proposals", () => proposals.tick());
    safely("storage", () => storage.tick());
    safely("boxes", () => brain.boxes.backends?.tick());
  }, 10_000);
});

const web = webHandler(config.webDir);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Development mode shows anyone a stack trace for an error.
  development: false,
  error(err) {
    console.error(err);
    return new Response("Internal error", { status: 500 });
  },
  // Attachments are at most 25 MB; a little over for the multipart framing.
  maxRequestBodySize: 26 * 1024 * 1024,
  // Bun drops a request whose answer takes over 10 seconds, and Check everything or deleting a
  // conversation can wait that long on the desktop or a model. 255 is the most Bun allows.
  idleTimeout: 255,
  fetch: (req, srv) =>
    new URL(req.url).pathname.startsWith("/api/") ? app.fetch(req, srv) : web(req),
  // Only what's sent with `compress` (routes/stream.ts) is compressed: live frames are JPEG already.
  websocket: { ...websocket, perMessageDeflate: { compress: "32KB", decompress: true } },
});
console.log(`hatbot brain listening on http://${urlHost(config.host)}:${server.port}`);
if (!auth.isSetUp()) {
  console.log(`First run: open ${config.publicUrl}/setup and enter setup code ${auth.setupCode}`);
}
if (!secrets.apiKey())
  console.warn("No Anthropic API key is set; chat replies fail until one is added in Settings");
