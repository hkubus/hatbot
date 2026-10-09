import { websocket } from "hono/bun";
import { AnthropicModelClient } from "./agent/model";
import { Thread } from "./agent/thread";
import { createApp } from "./app";
import { AuthService, FailureLimiter } from "./auth/service";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { EventBus } from "./events";
import { MemoryStore } from "./memory/store";
import { SettingsStore } from "./settings";
import { Spend } from "./spend";
import { webHandler } from "./web";

const config = loadConfig();
const db = openDb(config.dbPath);
const auth = new AuthService(db);
const events = new EventBus();
const settings = new SettingsStore(db);
const spend = new Spend(db, settings, events);
const memory = new MemoryStore(config.memoryDir);
await memory.init();
const thread = new Thread({
  db,
  memory,
  events,
  spend,
  settings,
  model: new AnthropicModelClient(),
});
const loginLimits = {
  perIp: new FailureLimiter(10, 15 * 60_000),
  global: new FailureLimiter(50, 15 * 60_000),
};

const app = createApp({ config, db, auth, loginLimits, events, settings, spend, memory, thread });
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
