// A live brain on a seeded database, for measuring HTTP latency end to end (TCP, JSON, compression):
//
//   bun benchmarks/serve.ts [port]        # then load it with something such as autocannon
//
// Prints the cookie to send as `Cookie:` and leaves the data under /tmp/hb-serve-*.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../apps/brain/src/config";
import { openDb } from "../apps/brain/src/db";
import { EventBus } from "../apps/brain/src/events";
import { MemoryStore } from "../apps/brain/src/memory/store";
import { Secrets } from "../apps/brain/src/secrets";
import { createServices } from "../apps/brain/src/services";
import { FakeDesktop } from "../apps/brain/test/fake-desktop";
import { FakeHatbox } from "../apps/brain/test/fake-hatbox";
import { FakeModel } from "../apps/brain/test/fake-model";
import { Proxmox } from "../plugins/proxmox/src/client";

const port = Number(process.argv[2] ?? 8099);
const ORIGIN = `http://127.0.0.1:${port}`;
const CHATS = Number(process.env.HB_CHATS ?? 20);
const MESSAGES = Number(process.env.HB_MESSAGES ?? 2000);
const dir = process.env.HB_DIR ?? mkdtempSync(join(tmpdir(), "hb-serve-"));
mkdirSync(join(dir, "memory"), { recursive: true });
const db = openDb(join(dir, "brain.db"));
await new MemoryStore(join(dir, "memory"), db, new EventBus()).init();
const ts = (i: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString();
db.transaction(() => {
  db.query(
    "INSERT OR IGNORE INTO bots (id, name, instructions) VALUES ('hatbot','Hatbot','')",
  ).run();
  for (let i = 1; i <= CHATS; i++) {
    db.query(
      "INSERT OR IGNORE INTO conversations (id, kind, created_at) VALUES (?, 'direct', ?)",
    ).run(i, ts(0));
    db.query(
      "INSERT OR IGNORE INTO conversation_bots (conversation_id, bot_id, position) VALUES (?, 'hatbot', 0)",
    ).run(i);
    for (let j = 0; j < MESSAGES; j++) {
      const role = j % 2 ? "assistant" : "user";
      db.query(
        "INSERT INTO messages (conversation_id, role, text, status, incognito, created_at) VALUES (?,?,?,?,?,?)",
      ).run(i, role, `${role} ${i}.${j} zebras `.repeat(6), "done", 0, ts(i * MESSAGES + j));
    }
  }
})();
const config = {
  ...loadConfig({ HATBOT_PUBLIC_URL: ORIGIN, HATBOT_DATA_DIR: dir }),
  dataDir: dir,
  memoryDir: join(dir, "memory"),
  archiveDir: join(dir, "archive"),
  updateDir: join(dir, "update"),
  updateRequest: join(dir, "update", "request"),
  releaseFile: join(dir, "update", "release.json"),
};
mkdirSync(config.archiveDir);
mkdirSync(config.updateDir);
const model = new FakeModel();
const s = await createServices({
  config,
  db,
  clock: () => Date.parse("2026-10-09T12:00:00Z"),
  model,
  taskModel: new FakeModel(),
  agent: new FakeDesktop(),
  hatbox: new FakeHatbox(),
  notifications: { send: async () => {} },
  ntfy: null,
  proxmox: new Proxmox({}),
  plugins: [],
  pluginEnv: {},
  secrets: new Secrets(join(dir, "secrets.json"), { ANTHROPIC_API_KEY: "k" }, async () => {}),
  passwordCost: { memoryCost: 8, timeCost: 1 },
  fetch: async () => new Response(null, { status: 404 }),
} as never);
await s.plugins.startAll();
const cookie = `hatbot_session=${s.auth.createSession(null)}`;
writeFileSync(join(dir, "cookie"), cookie);
Bun.serve({ port, fetch: s.app.fetch, error: (e) => new Response(String(e), { status: 500 }) });
console.log(`${ORIGIN}  cookie: ${cookie}`);
