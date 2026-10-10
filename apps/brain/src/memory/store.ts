// The memory repo (PLAN.md §7.2): markdown files in git. Every write is a commit.
import { mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

export type Author = { name: string; email: string };
export const HATBOT: Author = { name: "Hatbot", email: "hatbot@local" };

export type MemoryFile = { path: string; size: number };
export type Commit = {
  sha: string;
  author: string;
  date: string;
  message: string;
  files: string[];
};
export type SearchHit = { path: string; line: number; text: string };

export class MemoryError extends Error {}

export class MemoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  /** Creates the repo if it doesn't exist (the brain's provisioning normally does this). */
  async init() {
    mkdirSync(this.dir, { recursive: true });
    if ((await this.git(["rev-parse", "--is-inside-work-tree"], { allowFail: true })).code !== 0) {
      await this.git(["init", "-q", "-b", "main"]);
      await writeFile(join(this.dir, "INDEX.md"), "# Memory index\n");
      await this.git(["add", "-A"]);
      await this.commitAs(HATBOT, "Start memory");
    }
  }

  /** Resolves a repo-relative path, refusing anything outside the repo or inside .git. */
  resolve(path: string, { markdown = false } = {}): { rel: string; abs: string } {
    const rel = normalize(path).replace(/^(\.\/)+/, "");
    if (!rel || rel === "." || rel.startsWith("..") || rel.startsWith(sep) || rel.includes("\0")) {
      throw new MemoryError(`invalid path: ${path}`);
    }
    if (rel.split(sep).some((p) => p === ".git" || p === ".."))
      throw new MemoryError(`invalid path: ${path}`);
    if (markdown && !rel.endsWith(".md")) throw new MemoryError("only .md files can be written");
    return { rel, abs: join(this.dir, rel) };
  }

  async tree(): Promise<MemoryFile[]> {
    const out: MemoryFile[] = [];
    const walk = async (rel: string) => {
      for (const entry of await readdir(join(this.dir, rel), { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === ".gitkeep") continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile())
          out.push({ path: child, size: (await stat(join(this.dir, child))).size });
      }
    };
    await walk("");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<string> {
    const { abs } = this.resolve(path);
    try {
      return await readFile(abs, "utf8");
    } catch {
      throw new MemoryError(`not found: ${path}`);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      return (await stat(this.resolve(path).abs)).isFile();
    } catch {
      return false;
    }
  }

  /** Writes a file and commits it. Returns the commit, or null if the content didn't change. */
  write(path: string, content: string, author: Author, message: string): Promise<string | null> {
    return this.writeAll([{ path, content }], author, message);
  }

  /** Writes several files in one commit. */
  writeAll(
    files: { path: string; content: string }[],
    author: Author,
    message: string,
  ): Promise<string | null> {
    return this.serial(async () => {
      const resolved = files.map((f) => ({ ...this.resolve(f.path, { markdown: true }), ...f }));
      for (const { rel, abs, content } of resolved) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content.endsWith("\n") ? content : `${content}\n`);
        await this.git(["add", "--", rel]);
      }
      return this.commitAs(author, message);
    });
  }

  delete(path: string, author: Author, message: string): Promise<string | null> {
    return this.serial(async () => {
      const { rel, abs } = this.resolve(path);
      if (!(await this.exists(rel))) throw new MemoryError(`not found: ${path}`);
      await rm(abs);
      await this.git(["add", "-A", "--", rel]);
      return this.commitAs(author, message);
    });
  }

  async search(query: string, limit = 50): Promise<SearchHit[]> {
    const res = await this.git(["grep", "-n", "-I", "-i", "-F", "-e", query, "--", "."], {
      allowFail: true,
    });
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, limit)
      .map((line) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(line);
        return m
          ? { path: m[1] as string, line: Number(m[2]), text: (m[3] as string).slice(0, 300) }
          : null;
      })
      .filter((h): h is SearchHit => h !== null);
  }

  async log(limit = 50, path?: string): Promise<Commit[]> {
    const args = ["log", `-n${limit}`, "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--name-only"];
    if (path) args.push("--", this.resolve(path).rel);
    const res = await this.git(args, { allowFail: true });
    return res.stdout
      .split("\x1e")
      .filter((s) => s.trim())
      .map((chunk) => {
        const [head = "", ...files] = chunk.split("\n");
        const [sha = "", author = "", date = "", message = ""] = head.split("\x1f");
        return { sha, author, date, message, files: files.filter(Boolean) };
      });
  }

  async diff(sha: string): Promise<string> {
    this.checkSha(sha);
    return (await this.git(["show", "--format=", "--no-color", sha])).stdout;
  }

  /** Undoes a commit with a new commit. Fails cleanly if later edits conflict. */
  revert(sha: string, author: Author): Promise<string | null> {
    this.checkSha(sha);
    return this.serial(async () => {
      const res = await this.git(["revert", "--no-commit", sha], { allowFail: true });
      if (res.code !== 0) {
        await this.git(["revert", "--abort"], { allowFail: true });
        throw new MemoryError("can't revert: later changes touch the same lines");
      }
      const subject = (await this.git(["log", "-1", "--format=%s", sha])).stdout.trim();
      return this.commitAs(author, `Revert "${subject}"`);
    });
  }

  private checkSha(sha: string) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new MemoryError("invalid commit");
  }

  private async commitAs(author: Author, message: string): Promise<string | null> {
    if ((await this.git(["diff", "--cached", "--quiet"], { allowFail: true })).code === 0)
      return null;
    await this.git(["commit", "-q", "-m", message], {
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: HATBOT.name,
        GIT_COMMITTER_EMAIL: HATBOT.email,
      },
    });
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async git(
    args: string[],
    opts: { allowFail?: boolean; env?: Record<string, string> } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["git", "-c", "core.quotepath=off", ...args], {
      cwd: this.dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
    return { code, stdout, stderr };
  }
}
