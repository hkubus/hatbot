// Where /search spends its time on a large history: FTS, task LIKEs, routines, memory.
// Seeds SEARCH_MESSAGES messages in SEARCH_CHATS chats, then times each part.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LISTED_CHAT } from "../apps/brain/src/agent/chats";
import { openDb } from "../apps/brain/src/db";
import { EventBus } from "../apps/brain/src/events";
import { MemoryStore } from "../apps/brain/src/memory/store";

const CHATS = Number(process.env.HB_SEARCH_CHATS ?? 20);
const MESSAGES = Number(process.env.HB_SEARCH_MESSAGES ?? 1000);
const dir = mkdtempSync(join(tmpdir(), "hb-search-"));
mkdirSync(join(dir, "memory"), { recursive: true });
const db = openDb(join(dir, "brain.db"));
const memory = new MemoryStore(join(dir, "memory"), db, new EventBus());
await memory.init();
const ts = (i: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString();
db.transaction(() => {
  for (let i = 1; i <= CHATS; i++) {
    db.query("INSERT OR IGNORE INTO bots (id, name, instructions) VALUES (?, ?, '')").run(
      `bot-${i}`,
      `Bot ${i}`,
    );
    db.query(
      "INSERT OR IGNORE INTO conversations (id, kind, created_at) VALUES (?, 'direct', ?)",
    ).run(i, ts(0));
    db.query(
      "INSERT OR IGNORE INTO conversation_bots (conversation_id, bot_id, position) VALUES (?, ?, 0)",
    ).run(i, `bot-${i}`);
    for (let j = 0; j < MESSAGES; j++) {
      const role = j % 2 ? "assistant" : "user";
      db.query(
        "INSERT INTO messages (conversation_id, role, text, status, incognito, created_at) VALUES (?,?,?,?,?,?)",
      ).run(
        i,
        role,
        `${role} ${i} said thing number ${j} about zebras and probes`,
        "done",
        0,
        ts(i * MESSAGES + j),
      );
    }
  }
})();
const fts = `"zebras"`;
const time = <T>(name: string, f: () => T) => {
  for (let i = 0; i < 3; i++) f();
  const n = 20;
  const t0 = performance.now();
  let r: T | undefined;
  for (let i = 0; i < n; i++) r = f();
  console.log(`${name.padEnd(24)} ${((performance.now() - t0) / n).toFixed(2).padStart(7)} ms`);
  return r;
};
time("fts only", () =>
  db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 30").all(fts),
);
time("fts + join + listed", () =>
  db
    .query(
      `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ? AND ${LISTED_CHAT} ORDER BY rank LIMIT 30`,
    )
    .all(fts),
);
time("fts order by m.id", () =>
  db
    .query(
      `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY m.id DESC LIMIT 30`,
    )
    .all(fts),
);
time("task like", () =>
  db
    .query("SELECT id FROM tasks WHERE title LIKE '%zebras%' OR goal LIKE '%zebras%' LIMIT 30")
    .all(),
);
time("routines", () =>
  db
    .query(
      `SELECT 'schedule', id, name FROM schedules WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\'
       UNION ALL SELECT 'trigger', id, name FROM triggers WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\'
       UNION ALL SELECT 'watcher', id, name FROM watchers WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\' OR source LIKE ?1 ESCAPE '\\' ORDER BY name`,
    )
    .all("%zebras%"),
);
await time("memory search", () => memory.search("zebras", 30));
