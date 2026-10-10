// The archive on the HDD mount (PLAN.md §7.3): screenshots, kept forever.
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export class Archive {
  constructor(
    private dir: string,
    private clock: () => number = Date.now,
  ) {}

  /** Saves a screenshot as `name`.webp in the day's folder for `owner` (a task id, or e.g. "teach-3"). */
  async saveScreen(owner: number | string, name: string, bytes: Uint8Array): Promise<string> {
    const d = new Date(this.clock());
    const pad = (n: number) => String(n).padStart(2, "0");
    const rel = join(
      "screens",
      String(d.getFullYear()),
      pad(d.getMonth() + 1),
      pad(d.getDate()),
      String(owner),
      `${name}.webp`,
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
}
