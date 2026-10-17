import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive";
import { openDb } from "../src/db";
import { inWorker } from "../src/db/worker";
import { Storage, storageLine } from "../src/storage";
import { setUpOwner, tempDirs, testApp } from "./helpers";

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), "hatbot-test-storage-"));
  tempDirs.push(dir);
  const db = openDb(join(dir, "hatbot.db"));
  const archive = new Archive(join(dir, "archive"));
  let now = Date.parse("2026-10-01T12:00:00");
  const storage = new Storage({ db, archive, clock: () => now });
  return { dir, db, archive, storage, advance: (ms: number) => (now += ms) };
}

test("storage counts the database and the archive, and how much it grew in a week", async () => {
  const { db, archive, storage, advance } = setUp();
  mkdirSync(join(archive.dir, "screens/2026/10/01/1"), { recursive: true });
  writeFileSync(join(archive.dir, "screens/2026/10/01/1/a.webp"), new Uint8Array(10_000));
  const first = await storage.measure();
  expect(first.databaseBytes).toBeGreaterThan(0);
  expect(first.screensBytes).toBeGreaterThanOrEqual(10_000);
  expect(first.filesBytes).toBe(0);
  expect(first.growth7dBytes).toBeNull();

  advance(7 * 86400_000);
  mkdirSync(join(archive.dir, "files/2026/10/08"), { recursive: true });
  writeFileSync(join(archive.dir, "files/2026/10/08/1-a.pdf"), new Uint8Array(50_000));
  const later = await storage.measure();
  expect(later.growth7dBytes).toBe(later.totalBytes - first.totalBytes);
  expect(storageLine(later)).toContain("more than a week ago");
  db.close();
});

test("the nightly copy is consistent, leaves incognito out, and only the last 7 are kept", async () => {
  const { db, archive, storage, advance } = setUp();
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
    advance(86400_000);
    await storage.upkeep();
  }
  expect(readdirSync(join(archive.dir, "db"))).toHaveLength(7);
  expect(await inWorker(db, { op: "quick_check", path: db.filename })).toBe("ok");
  db.close();
});

test("Check everything and the weekly report say how big storage is", async () => {
  const t = await testApp();
  await setUpOwner(t);
  const report = await t.checks.run();
  const storage = report.results.find((r) => r.id === "storage");
  expect(storage?.state).toBe("ok");
  expect(storage?.detail).toContain("Database");
  expect(report.storage?.databaseBytes).toBeGreaterThan(0);
  expect(report.results.find((r) => r.id === "database")?.state).toBe("ok");
  expect((await t.report.make()).text).toContain("- Storage: Database");
});
