import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./migrations";

export type Db = Database;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true, create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  // Deleted rows are zeroed on disk, so an incognito conversation doesn't linger in free pages.
  db.exec("PRAGMA secure_delete = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const row = db
    .query<{ v: number | null }, []>("SELECT max(version) AS v FROM schema_migrations")
    .get();
  const current = row?.v ?? 0;
  for (let v = current + 1; v <= migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v - 1] as string);
      db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    })();
  }
}

export const now = () => new Date().toISOString();
