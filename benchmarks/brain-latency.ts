// Latency of the brain's hot endpoints, on a seeded database at the volumes PLAN.md sizes for.
//
//   bun benchmarks/brain-latency.ts            # the default set
//   bun benchmarks/brain-latency.ts /conversations "/search?q=zebra"
//
// Seeds a template once (migrated DB + memory repo), then copies its file for each run, as
// test/helpers.ts does per test. Chats and messages are filled to the sizes given below.
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../apps/brain/src/config";
import { openDb } from "../apps/brain/src/db";
import { EventBus } from "../apps/brain/src/events";
import { MemoryStore } from "../apps/brain/src/memory/store";
import { Proxmox } from "../apps/brain/src/proxmox";
import { Secrets } from "../apps/brain/src/secrets";
import { createServices } from "../apps/brain/src/services";
import { FakeDesktop } from "../apps/brain/test/fake-desktop";
import { FakeHatbox } from "../apps/brain/test/fake-hatbox";
import { FakeModel } from "../apps/brain/test/fake-model";

const ORIGIN = "https://hatbot.test";
/** Chats filled, each with MESSAGES messages, and READ every fifth one. */
const CHATS = Number(process.env.HB_CHATS ?? 20);
const MESSAGES = Number(process.env.HB_MESSAGES ?? 2000);
const SEARCH_CHATS = Number(process.env.HB_SEARCH_CHATS ?? 20);
const SEARCH_MESSAGES = Number(process.env.HB_SEARCH_MESSAGES ?? 1000);

const dir = mkdtempSync(join(tmpdir(), "hb-bench-"));
mkdirSync(join(dir, "memory"), { recursive: true });
const seed = openDb(join(dir, "seed.db"));
await new MemoryStore(join(dir, "memory"), seed, new EventBus()).init();

const ts = (i: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString();
seed.transaction(() => {
  const bot = seed.query("INSERT OR IGNORE INTO bots (id, name, instructions) VALUES (?, ?, '')");
  const chat = seed.query(
    "INSERT OR IGNORE INTO conversations (id, kind, created_at) VALUES (?, 'direct', ?)",
  );
  const member = seed.query(
    "INSERT OR IGNORE INTO conversation_bots (conversation_id, bot_id, position) VALUES (?, ?, 0)",
  );
  const message = seed.query(
    "INSERT INTO messages (conversation_id, role, text, status, incognito, created_at, seen_at) VALUES (?,?,?,?,?,?,?)",
  );
  for (let i = 1; i <= SEARCH_CHATS; i++) {
    bot.run(`bot-${i}`, `Bot ${i}`);
    chat.run(i, ts(0));
    member.run(i, `bot-${i}`);
    for (let j = 0; j < SEARCH_MESSAGES; j++) {
      const role = j % 2 ? "assistant" : "user";
      message.run(
        i,
        role,
        `${role === "user" ? "Owner" : "Bot"} ${i} said thing number ${j} about zebras and probes`,
        "done",
        0,
        ts(i * SEARCH_MESSAGES + j),
        j % 5 === 0 || role === "user" ? ts(i * SEARCH_MESSAGES + j) : null,
      );
    }
  }
  // The default chat, which the unread and message listings read.
  for (let i = SEARCH_CHATS + 1; i <= SEARCH_CHATS + CHATS; i++) {
    chat.run(i, ts(0));
    member.run(i, "hatbot");
    for (let j = 0; j < MESSAGES; j++) {
      const role = j % 2 ? "assistant" : "user";
      message.run(
        i,
        role,
        `${role} ${i}.${j} `.repeat(20),
        "done",
        0,
        ts(i * MESSAGES + j),
        j % 5 === 0 || role === "user" ? ts(i * MESSAGES + j) : null,
      );
    }
  }
})();
seed.close();

const dbPath = join(dir, "brain.db");
copyFileSync(join(dir, "seed.db"), dbPath);
const db = openDb(dbPath);
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

const OWNER_BOARDS = Number(process.env.HB_BOARDS ?? 0);
const CARDS_PER_BOARD = Number(process.env.HB_CARDS ?? 0);
if (OWNER_BOARDS) {
  // A Trello-sized homelab: boards, lists and cards as tasks in a workflow.
  const now = ts(0);
  db.transaction(() => {
    const t = db.query(
      `INSERT INTO tasks (title, goal, status, lane, origin, bot_id, model, budget_usd, created_at) VALUES (?,?,?,?,?,?,'claude-haiku-5-5',1,?)`,
    );
    const list = t;
    for (let b = 0; b < OWNER_BOARDS; b++) {
      const boardId = list.run(
        `Board ${b}`,
        "A board",
        "done",
        "background",
        "chat",
        "hatbot",
        now,
      ).lastInsertRowid;
      for (let l = 0; l < 4; l++) {
        const listId = list.run(
          `List ${b}.${l}`,
          "A list",
          "done",
          "background",
          "chat",
          "hatbot",
          now,
        ).lastInsertRowid;
        db.query("UPDATE tasks SET parent_id = ? WHERE id = ?").run(boardId, listId);
        for (let c = 0; c < CARDS_PER_BOARD / 4; c++)
          db.query(
            "INSERT INTO tasks (title, goal, status, lane, origin, bot_id, model, budget_usd, created_at, parent_id) VALUES (?,?,?,?,?,?,'claude-haiku-5-5',1,?,?)",
          ).run(
            `Card ${b}.${l}.${c} zebras`,
            "Move it to Done",
            "done",
            "background",
            "chat",
            "hatbot",
            now,
            listId,
          );
      }
    }
  })();
}

const model = new FakeModel();
const taskModel = new FakeModel();
taskModel.onCreate = () => '{"suspected": false, "excerpt": ""}';
const s = await createServices({
  config,
  db,
  clock: () => Date.parse("2026-10-09T12:00:00Z"),
  model,
  taskModel,
  agent: new FakeDesktop(),
  hatbox: new FakeHatbox(),
  notifications: { send: async () => {} },
  ntfy: null,
  proxmox: new Proxmox({}),
  plugins: [],
  pluginEnv: {},
  secrets: new Secrets(join(dir, "secrets.json"), { ANTHROPIC_API_KEY: "k" }, async () => {}),
  passwordCost: { memoryCost: 8, timeCost: 1 },
  fetch: async (url: string) =>
    url === `${ORIGIN}/api/v1/health`
      ? Response.json({ ok: true })
      : new Response(null, { status: 404 }),
} as never);
await s.plugins.startAll();
const cookie = `hatbot_session=${s.auth.createSession(null)}`;

const given = process.argv.slice(2);
const first = SEARCH_CHATS + 1;
const paths = given.length
  ? given
  : [
      "/conversations",
      "/thread/unread",
      `/conversations/${first}/messages?limit=50`,
      "/bots",
      "/tasks",
      "/approvals",
      "/schedules",
      "/search?q=zebras",
      "/search?q=thing%20999",
    ];

const json = { iterations: 0 };
for (const p of paths) {
  const url = `/api/v1${p}`;
  for (let i = 0; i < 5; i++) await s.app.request(url, { headers: { cookie } });
  const n = 60;
  const t0 = performance.now();
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const r = await s.app.request(url, { headers: { cookie } });
    bytes += (await r.arrayBuffer()).byteLength;
    if (r.status >= 300) console.log(`   ${p}: status ${r.status}`);
  }
  json.iterations = n;
  console.log(
    `${p.padEnd(44)} ${((performance.now() - t0) / n).toFixed(2).padStart(8)} ms/req ${String(
      Math.round(bytes / n / 1024),
    ).padStart(7)} KB/req`,
  );
}
process.exit(0);
