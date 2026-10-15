import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations, REBUILD } from "./migrations";

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
    const sql = migrations[v - 1] as string;
    // A table other tables point at is rebuilt with foreign keys off, as SQLite's docs say; they
    // can't be switched inside a transaction.
    const rebuild = sql.includes(REBUILD);
    if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        if (rebuild && db.query("PRAGMA foreign_key_check").get())
          throw new Error(`migration ${v} broke a foreign key`);
        db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
      })();
    } finally {
      if (rebuild) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

export const now = () => new Date().toISOString();
