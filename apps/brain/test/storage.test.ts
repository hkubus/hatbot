import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive";
import { openDb } from "../src/db";
import { inWorker } from "../src/db/worker";
import { Storage } from "../src/storage";
import { tempDirs } from "./helpers";

test("the nightly copy is consistent, leaves incognito out, and only the last 7 are kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-test-storage-"));
  tempDirs.push(dir);
  const db = openDb(join(dir, "hatbot.db"));
  const archive = new Archive(join(dir, "archive"));
  let clock = Date.parse("2026-10-01T12:00:00");
  const storage = new Storage({ db, archive, clock: () => clock });
  const now = "2026-10-01T12:00:00Z";
  db.exec(
    `INSERT INTO episodes (started_at, last_activity_at, incognito) VALUES ('${now}', '${now}', 1)`,
  );
  db.exec(`INSERT INTO messages (episode_id, role, text, status, created_at, kind, incognito)
    VALUES (1, 'user', 'secret', 'done', '${now}', 'text', 1), (NULL, 'user', 'kept', 'done', '${now}', 'text', 0)`);
  const path = await storage.snapshot();
  const copy = new Database(path, { readonly: true });
  expect(copy.query("SELECT text FROM messages").values().flat()).toEqual(["kept"]);
  expect(copy.query("SELECT count(*) FROM episodes").values()[0]?.[0]).toBe(0);
  copy.close();
  // The live database is untouched.
  expect(db.query("SELECT count(*) FROM messages").values()[0]?.[0]).toBe(2);

  for (let i = 0; i < 8; i++) {
    clock += 86400_000;
    await storage.upkeep();
  }
  expect(readdirSync(join(archive.dir, "db"))).toHaveLength(7);
  expect(await inWorker(db, { op: "quick_check", path: db.filename })).toBe("ok");
  db.close();
});
