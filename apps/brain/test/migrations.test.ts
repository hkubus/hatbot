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

// A fresh database has empty tables, and some ALTERs and rebuilds only fail on one with rows.
test("an upgrade keeps a database in use: its chat, tasks and links, its search, and no attachment id given out again", () => {
  const db = at(19);
  const now = "2026-10-01T00:00:00Z";
  db.exec(`INSERT INTO settings (key, value) VALUES ('thread_summary', 'Earlier: backups.')`);
  db.exec(`INSERT INTO episodes (started_at, last_activity_at) VALUES ('${now}', '${now}')`);
  db.exec(`INSERT INTO tasks (title, goal, success_criteria, origin, lane, model, status, summary, budget_usd, created_at, parent_id)
    VALUES ('a', 'g', '', 'chat', 'background', 'm', 'done', 'All fine.', 1, '${now}', NULL),
      ('b', 'g', '', 'chat', 'screen', 'm', 'done', 'Read it.', 1, '${now}', 1)`);
  db.exec(`INSERT INTO messages (episode_id, role, text, status, created_at, kind, task_id, incognito)
    VALUES (1, 'user', 'I renamed the backups share', 'done', '${now}', 'text', NULL, 0),
      (1, 'assistant', 'On it.', 'done', '${now}', 'text', 1, 0),
      (1, 'user', 'my secret password', 'done', '${now}', 'text', NULL, 1)`);
  db.exec(`INSERT INTO approvals (kind, summary, reason, sources, status, created_at, expires_at)
    VALUES ('k', 's', 'r', '[]', 'pending', '${now}', '${now}')`);
  db.exec(`INSERT INTO attachments (id, message_id, name, media_type, size, path, sender, created_at)
    VALUES (1, 1, 'a.png', 'image/png', 3, 'files/a', 'owner', '${now}')`);

  migrate(db);

  expect(db.query("SELECT summary FROM conversations WHERE id = 1").get()).toEqual({
    summary: "Earlier: backups.",
  });
  expect(db.query("SELECT conversation_id, bot_id FROM messages WHERE id < 3").all()).toEqual([
    { conversation_id: 1, bot_id: null },
    { conversation_id: 1, bot_id: "hatbot" },
  ]);
  expect(db.query("SELECT bot_id FROM tasks WHERE id = 1").get()).toEqual({ bot_id: "hatbot" });
  // An ended task's result is in the place of the reply that started it.
  expect(db.query("SELECT text FROM messages WHERE id = 2").get()).toEqual({ text: "All fine." });
  expect(db.query("SELECT parent_id FROM tasks WHERE id = 2").get()).toEqual({ parent_id: 1 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  // Attachments kept; ones deleted before may have had higher ids, so new ones start well past.
  expect(db.query("SELECT name FROM attachments").all()).toEqual([{ name: "a.png" }]);
  const added = db
    .query<{ id: number }, []>(
      `INSERT INTO attachments (name, media_type, size, path, sender, created_at)
       VALUES ('c', 'text/plain', 1, '', 'owner', '${now}') RETURNING id`,
    )
    .get()?.id;
  expect(added).toBeGreaterThan(1000);
  // The search index is rebuilt to find words in any form, and incognito stays out.
  const match = (q: string) =>
    db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(q);
  expect(match("renaming backup")).toEqual([{ rowid: 1 }]);
  expect(match("secret")).toEqual([]);
});
