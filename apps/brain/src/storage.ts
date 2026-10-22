// How much room Hatbot takes and how fast it grows, for Check everything and the weekly report; and the
// nightly upkeep: PRAGMA optimize, and a consistent copy of the database into the archive, so a backup
// of the HDD has one even if the live file is caught mid-write.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StorageInfo } from "@hatbot/shared";
import type { Archive } from "./archive";
import type { Db } from "./db";
import { inWorker } from "./db/worker";
import { getSetting, setSetting } from "./settings";

const HISTORY_KEY = "storage:history";
const UPKEEP_KEY = "storage:upkeep";
const KEEP_SAMPLES = 30;
const KEEP_SNAPSHOTS = 7;
/** Upkeep runs once a day, at this hour or the first tick after. */
const UPKEEP_HOUR = 3;
const DAY = 86400_000;

type Sample = { day: string; total: number };

export type StorageDeps = { db: Db; archive: Archive; clock?: () => number };

const dayOf = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function dirSize(dir: string): Promise<number> {
  try {
    const p = Bun.spawn(["du", "-sb", dir], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) === 0) return Number(out.split(/\s/)[0]) || 0;
  } catch {
    // No du: walk it.
  }
  let total = 0;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries)
    if (e.isFile()) total += (await stat(join(e.parentPath, e.name)).catch(() => null))?.size ?? 0;
  return total;
}

export const bytes = (n: number) => {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${n < 0 ? "-" : ""}${i ? v.toFixed(1) : v} ${units[i]}`;
};

/** In a line: "Database 120.0 MB (WAL 4.0 MB), screenshots 3.1 GB, files 200.0 MB; 250.0 MB more than a week ago." */
export function storageLine(s: StorageInfo): string {
  const parts = [
    `database ${bytes(s.databaseBytes)}${s.walBytes ? ` (WAL ${bytes(s.walBytes)})` : ""}`,
    `screenshots ${bytes(s.screensBytes)}`,
    `files ${bytes(s.filesBytes)}`,
    ...(s.snapshotsBytes ? [`database copies ${bytes(s.snapshotsBytes)}`] : []),
  ];
  const line = parts.join(", ");
  const growth =
    s.growth7dBytes === null
      ? ""
      : s.growth7dBytes >= 0
        ? `; ${bytes(s.growth7dBytes)} more than a week ago`
        : `; ${bytes(-s.growth7dBytes)} less than a week ago`;
  return `${line[0]?.toUpperCase()}${line.slice(1)}${growth}.`;
}

export class Storage {
  private clock: () => number;
  private busy = false;

  constructor(private d: StorageDeps) {
    this.clock = d.clock ?? Date.now;
  }

  private get snapshotDir() {
    return join(this.d.archive.dir, "db");
  }

  /** Also keeps today's sample for later weeks. */
  async measure(): Promise<StorageInfo> {
    const file = this.d.db.filename;
    const size = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;
    const inMemory = !file || file === ":memory:";
    const page = (pragma: string) =>
      Number(this.d.db.query(`PRAGMA ${pragma}`).values()[0]?.[0] ?? 0);
    const databaseBytes = inMemory ? page("page_count") * page("page_size") : await size(file);
    const walBytes = inMemory ? 0 : await size(`${file}-wal`);
    const root = this.d.archive.dir;
    const [screensBytes, filesBytes, snapshotsBytes] = await Promise.all([
      dirSize(join(root, "screens")),
      dirSize(join(root, "files")),
      dirSize(this.snapshotDir),
    ]);
    const totalBytes = databaseBytes + walBytes + screensBytes + filesBytes + snapshotsBytes;
    const now = this.clock();
    const today = dayOf(now);
    const weekAgo = dayOf(now - 7 * DAY);
    const history = this.history().filter((s) => s.day !== today);
    // The newest sample from a week ago or before.
    const then = history.filter((s) => s.day <= weekAgo).at(-1);
    setSetting(
      this.d.db,
      HISTORY_KEY,
      JSON.stringify([...history, { day: today, total: totalBytes }].slice(-KEEP_SAMPLES)),
    );
    return {
      at: new Date(now).toISOString(),
      databaseBytes,
      walBytes,
      screensBytes,
      filesBytes,
      snapshotsBytes,
      totalBytes,
      growth7dBytes: then ? totalBytes - then.total : null,
    };
  }

  tick() {
    if (this.busy) return;
    const now = this.clock();
    if (new Date(now).getHours() < UPKEEP_HOUR) return;
    const day = dayOf(now);
    const upkept = getSetting(this.d.db, UPKEEP_KEY);
    if (upkept !== null && JSON.parse(upkept) === day) return;
    void this.upkeep(day);
  }

  async upkeep(day = dayOf(this.clock())) {
    this.busy = true;
    // Marked first, so one that fails isn't tried again every few seconds.
    setSetting(this.d.db, UPKEEP_KEY, JSON.stringify(day));
    try {
      this.d.db.exec("PRAGMA optimize");
      await this.snapshot(day);
      await this.measure();
    } catch (err) {
      console.error("storage upkeep failed", err);
    } finally {
      this.busy = false;
    }
  }

  async snapshot(day = dayOf(this.clock())): Promise<string> {
    await mkdir(this.snapshotDir, { recursive: true });
    const target = join(this.snapshotDir, `hatbot-${day}.sqlite`);
    await inWorker(this.d.db, { op: "snapshot", path: this.d.db.filename, target });
    const old = (await readdir(this.snapshotDir))
      .filter((f) => /^hatbot-\d{4}-\d\d-\d\d\.sqlite$/.test(f))
      .sort()
      .slice(0, -KEEP_SNAPSHOTS);
    for (const f of old) await rm(join(this.snapshotDir, f), { force: true });
    return target;
  }

  private history(): Sample[] {
    const v = getSetting(this.d.db, HISTORY_KEY);
    return v === null ? [] : ((JSON.parse(v) as Sample[] | null) ?? []);
  }
}
