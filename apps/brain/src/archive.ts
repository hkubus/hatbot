import { mkdir, rm, statfs } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export class Archive {
  constructor(
    readonly dir: string,
    private clock: () => number = Date.now,
  ) {}

  private dayDir(kind: string, t: number) {
    const d = new Date(t);
    const pad = (n: number) => String(n).padStart(2, "0");
    return join(kind, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  }

  private screenDir(owner: number | string, t: number) {
    return join(this.dayDir("screens", t), String(owner));
  }

  private async save(rel: string, bytes: Uint8Array): Promise<string> {
    const abs = join(this.dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await Bun.write(abs, bytes);
    return rel;
  }

  saveScreen(owner: number | string, name: string, bytes: Uint8Array): Promise<string> {
    return this.save(join(this.screenDir(owner, this.clock()), `${name}.webp`), bytes);
  }

  async removeScreens(owner: string, from: number, to: number) {
    const end = Math.min(to, from + 31 * 86_400_000);
    const dirs = new Set<string>();
    // Half-day steps, so a day a clock change shortens isn't skipped.
    for (let t = from; t < end; t += 43_200_000) dirs.add(this.screenDir(owner, t));
    dirs.add(this.screenDir(owner, end));
    for (const dir of dirs) await rm(join(this.dir, dir), { recursive: true, force: true });
  }

  saveFile(id: number, name: string, bytes: Uint8Array): Promise<string> {
    const safe = name.replace(/[^\w.-]+/g, "_").slice(-100) || "file";
    return this.save(join(this.dayDir("files", this.clock()), `${id}-${safe}`), bytes);
  }

  /** A file for reading, or null if the path leaves the archive. */
  file(rel: string) {
    const root = resolve(this.dir);
    const abs = resolve(root, rel);
    if (!abs.startsWith(root + sep)) return null;
    return Bun.file(abs);
  }

  async remove(rel: string) {
    const f = this.file(rel);
    if (f?.name) await rm(f.name, { force: true });
  }

  async probe(): Promise<number> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, ".check");
    await Bun.write(path, "ok");
    await rm(path, { force: true });
    const fs = await statfs(this.dir);
    return fs.bavail * fs.bsize;
  }
}
