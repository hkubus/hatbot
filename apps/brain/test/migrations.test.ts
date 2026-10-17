import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../src/db";
import { migrations } from "../src/db/migrations";

/** A database at `version`, with foreign keys on as in openDb. */
function at(version: number) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
  for (let v = 1; v <= version; v++) {
    db.exec(migrations[v - 1] as string);
    db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
  }
  return db;
}

// A fresh database has empty tables, and some ALTERs only fail on one with rows.
test("migration 20 (bots) runs on a database with a thread, tasks and approvals", () => {
  const db = at(19);
  const now = "2026-10-01T00:00:00Z";
  db.exec(`INSERT INTO settings (key, value) VALUES ('thread_summary', 'Earlier: backups.')`);
  db.exec(`INSERT INTO episodes (started_at, last_activity_at) VALUES ('${now}', '${now}')`);
  db.exec(`INSERT INTO messages (episode_id, role, text, status, created_at, kind)
    VALUES (1, 'user', 'hi', 'done', '${now}', 'text'), (1, 'assistant', 'Hello.', 'done', '${now}', 'text')`);
  db.exec(`INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at)
    VALUES ('t', 'g', '', 'chat', 'background', 'm', 'done', 1, '${now}')`);
  db.exec(`INSERT INTO approvals (kind, summary, reason, sources, status, created_at, expires_at)
    VALUES ('k', 's', 'r', '[]', 'pending', '${now}', '${now}')`);

  migrate(db);

  expect(db.query("SELECT summary FROM conversations WHERE id = 1").get()).toEqual({
    summary: "Earlier: backups.",
  });
  expect(db.query("SELECT conversation_id, bot_id FROM messages ORDER BY id").all()).toEqual([
    { conversation_id: 1, bot_id: null },
    { conversation_id: 1, bot_id: "hatbot" },
  ]);
  expect(db.query("SELECT conversation_id FROM episodes").get()).toEqual({ conversation_id: 1 });
  expect(db.query("SELECT conversation_id, bot_id FROM tasks").get()).toEqual({
    conversation_id: 1,
    bot_id: "hatbot",
  });
});

test("migration 32 keeps attachments, and their ids aren't given out again", () => {
  const fresh = at(31);
  migrate(fresh);
  expect(
    fresh
      .query<{ id: number }, []>(
        `INSERT INTO attachments (name, media_type, size, path, sender, created_at)
         VALUES ('c', 'text/plain', 1, '', 'owner', 'now') RETURNING id`,
      )
      .get()?.id,
  ).toBe(1);

  const db = at(31);
  const now = "2026-10-01T00:00:00Z";
  db.exec(`INSERT INTO messages (role, text, status, created_at, kind)
    VALUES ('user', 'hi', 'done', '${now}', 'text')`);
  db.exec(`INSERT INTO attachments (id, name, media_type, size, path, sender, created_at, for_chat)
    VALUES (1, 'a.png', 'image/png', 3, 'files/a', 'owner', '${now}', 0),
      (2, 'b.pdf', 'application/pdf', 4, 'files/b', 'hatbot', '${now}', 1)`);
  migrate(db);
  expect(db.query("SELECT id, name, for_chat FROM attachments ORDER BY id").all()).toEqual([
    { id: 1, name: "a.png", for_chat: 0 },
    { id: 2, name: "b.pdf", for_chat: 1 },
  ]);
  const add = () =>
    db
      .query<{ id: number }, []>(
        `INSERT INTO attachments (name, media_type, size, path, sender, created_at)
         VALUES ('c', 'text/plain', 1, '', 'owner', '${now}') RETURNING id`,
      )
      .get()?.id ?? 0;
  // Ones deleted before the migration may have had higher ids: new ones start well past.
  const first = add();
  expect(first).toBeGreaterThan(1000);
  db.exec(`DELETE FROM attachments WHERE id = ${first}`);
  expect(add()).toBe(first + 1);
});

test("migration 22 puts an ended task's result in the place of the reply that started it", () => {
  const db = at(21);
  const now = "2026-10-01T00:00:00Z";
  db.exec(`INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, summary, budget_usd, created_at)
    VALUES ('a', 'g', '', 'chat', 'background', 'm', 'done', 'All fine.', 1, '${now}'),
      ('b', 'g', '', 'chat', 'background', 'm', 'failed', 'No route.', 1, '${now}'),
      ('c', 'g', '', 'chat', 'background', 'm', 'cancelled', null, 1, '${now}')`);
  db.exec(`INSERT INTO messages (role, text, status, created_at, kind, task_id) VALUES
    ('assistant', 'On it.', 'done', '${now}', 'text', 1),
    ('assistant', 'Started a task.', 'done', '${now}', 'command', 2),
    ('assistant', 'On it.', 'done', '${now}', 'text', 3)`);

  migrate(db);

  expect(db.query("SELECT text FROM messages ORDER BY id").all()).toEqual([
    { text: "All fine." },
    { text: "**Didn't finish.** No route." },
    { text: "On it." },
  ]);
});

test("migration 24 rebuilds tasks for watchers and keeps their rows and links", () => {
  const db = at(23);
  const now = "2026-10-01T00:00:00Z";
  db.exec(`INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at)
    VALUES ('a', 'g', '', 'chat', 'background', 'm', 'done', 1, '${now}')`);
  db.exec(`INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at, parent_id)
    VALUES ('b', 'g', '', 'chat', 'screen', 'm', 'done', 1, '${now}', 1)`);
  db.exec(`INSERT INTO messages (role, text, status, created_at, kind, task_id) VALUES
    ('assistant', 'On it.', 'done', '${now}', 'text', 1)`);

  migrate(db);

  expect(db.query("SELECT id, parent_id, watcher_id FROM tasks ORDER BY id").all()).toEqual([
    { id: 1, parent_id: null, watcher_id: null },
    { id: 2, parent_id: 1, watcher_id: null },
  ]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  // Watchers and the heartbeat start tasks too.
  db.exec(`INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, budget_usd, created_at)
    VALUES ('c', 'g', '', 'heartbeat', 'background', 'm', 'running', 1, '${now}')`);
});

test("migration 26 indexes per-task lookups, and they're used", () => {
  const db = at(25);
  migrate(db);
  const plan = (sql: string) =>
    db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => r.detail)
      .join(" ");
  expect(plan("SELECT * FROM spend_ledger WHERE task_id = 1")).toContain("spend_ledger_task");
  expect(plan("SELECT * FROM messages WHERE task_id = 1")).toContain("messages_task");
  expect(plan("SELECT * FROM tasks WHERE schedule_id = 1")).toContain("tasks_schedule");
  expect(plan("SELECT * FROM tasks WHERE parent_id = 1")).toContain("tasks_parent");
  expect(db.query("SELECT count(*) AS n FROM hook_deliveries").get()).toEqual({ n: 0 });
});
