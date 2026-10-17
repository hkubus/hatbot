// The archive on the HDD mount (PLAN.md §7.3): screenshots, kept forever.
import { mkdir, rm, statfs } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export class Archive {
  constructor(
    readonly dir: string,
    private clock: () => number = Date.now,
  ) {}

  /** Where `owner`'s screenshots from the day of `t` go. */
  private screenDir(owner: number | string, t: number) {
    const d = new Date(t);
    const pad = (n: number) => String(n).padStart(2, "0");
    return join(
      "screens",
      String(d.getFullYear()),
      pad(d.getMonth() + 1),
      pad(d.getDate()),
      String(owner),
    );
  }

  /** Saves a screenshot as `name`.webp in the day's folder for `owner` (a task id, or e.g. "teach-3"). */
  async saveScreen(owner: number | string, name: string, bytes: Uint8Array): Promise<string> {
    const rel = join(this.screenDir(owner, this.clock()), `${name}.webp`);
    const abs = join(this.dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await Bun.write(abs, bytes);
    return rel;
  }

  /** Deletes `owner`'s screenshots saved between `from` and `to` (at most a month of days). */
  async removeScreens(owner: string, from: number, to: number) {
    const end = Math.min(to, from + 31 * 86_400_000);
    const dirs = new Set<string>();
    // Half-day steps, so a day a clock change shortens isn't skipped.
    for (let t = from; t < end; t += 43_200_000) dirs.add(this.screenDir(owner, t));
    dirs.add(this.screenDir(owner, end));
    for (const dir of dirs) await rm(join(this.dir, dir), { recursive: true, force: true });
  }

  /** Saves a chat attachment in the day's folder as `<id>-<name>`. */
  async saveFile(id: number, name: string, bytes: Uint8Array): Promise<string> {
    const d = new Date(this.clock());
    const pad = (n: number) => String(n).padStart(2, "0");
    const safe = name.replace(/[^\w.-]+/g, "_").slice(-100) || "file";
    const rel = join(
      "files",
      String(d.getFullYear()),
      pad(d.getMonth() + 1),
      pad(d.getDate()),
      `${id}-${safe}`,
    );
    const abs = join(this.dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await Bun.write(abs, bytes);
    return rel;
  }

  /** A file for reading, or null if the path leaves the archive. */
  file(rel: string) {
    const root = resolve(this.dir);
    const abs = resolve(root, rel);
    if (!abs.startsWith(root + sep)) return null;
    return Bun.file(abs);
  }

  /** Deletes a file; one that's already gone is fine. */
  async remove(rel: string) {
    const f = this.file(rel);
    if (f?.name) await rm(f.name, { force: true });
  }

  /** Writes and removes a file, for the self-check; the free space left, in bytes. */
  async probe(): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, ".check");
    await Bun.write(path, "ok");
    await rm(path, { force: true });
    const fs = await statfs(this.dir);
    return fs.bavail * fs.bsize;
  }
}
