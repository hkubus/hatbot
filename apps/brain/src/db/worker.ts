// Slow database jobs on a connection of their own, so the brain keeps answering while they run:
// SQLite's quick check, and the nightly snapshot.
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

declare const self: Worker;

export type DbJob =
  | { op: "quick_check"; path: string }
  | { op: "snapshot"; path: string; target: string };
export type DbJobResult = { ok: true; result: string } | { ok: false; error: string };

/** Runs a job on `db`, or on its own connection to `path`. */
export function runJob(job: DbJob, db?: Database): string {
  const mode = job.op === "quick_check" ? { readonly: true } : { readwrite: true };
  const conn = db ?? new Database(job.path, mode);
  try {
    if (!db) conn.exec("PRAGMA busy_timeout = 5000");
    if (job.op === "quick_check")
      return conn.query("PRAGMA quick_check").values().flat().join("; ");
    rmSync(job.target, { force: true });
    // A consistent copy, even while the brain writes.
    conn.exec(`VACUUM INTO '${job.target.replaceAll("'", "''")}'`);
    scrub(job.target);
    return job.target;
  } finally {
    if (!db) conn.close();
  }
}

/** An open incognito conversation stays out of snapshots, as it stays out of everything else. */
function scrub(path: string) {
  const s = new Database(path);
  try {
    s.exec("PRAGMA secure_delete = ON");
    const episodes = "(SELECT id FROM episodes WHERE incognito = 1)";
    s.transaction(() => {
      s.exec(
        "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE incognito = 1)",
      );
      s.exec("DELETE FROM messages WHERE incognito = 1");
      s.exec(`DELETE FROM episode_turns WHERE episode_id IN ${episodes}`);
      s.exec(`UPDATE spend_ledger SET episode_id = NULL WHERE episode_id IN ${episodes}`);
      s.exec("DELETE FROM episodes WHERE incognito = 1");
    })();
    s.exec("VACUUM");
  } finally {
    s.close();
  }
}

if (typeof self !== "undefined" && !Bun.isMainThread)
  self.onmessage = (e: MessageEvent<DbJob>) => {
    let out: DbJobResult;
    try {
      out = { ok: true, result: runJob(e.data) };
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    self.postMessage(out);
  };

/** Runs a job in a worker; a database in memory can't be opened twice, so it runs on `db` there. */
export function inWorker(db: Database, job: DbJob): Promise<string> {
  if (db.filename === ":memory:" || !db.filename) return Promise.resolve(runJob(job, db));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./worker.ts", import.meta.url).href);
    w.onmessage = (e: MessageEvent<DbJobResult>) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage(job);
  });
}
