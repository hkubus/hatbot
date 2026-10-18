// The memory repo (PLAN.md §7.2): markdown files in git. Every write is a commit.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { Commit, MemoryFile, MemoryHit } from "@hatbot/shared";
import type { Db } from "../db";
import { UserError } from "../errors";
import type { EventBus } from "../events";
import { ftsQuery } from "../search";

export type Author = { name: string; email: string };
export const HATBOT: Author = { name: "Hatbot", email: "hatbot@local" };

export class MemoryError extends UserError {}

/** A file changed since it was read: what it is now. */
export class MemoryConflict extends MemoryError {
  constructor(
    readonly sha: string,
    readonly content: string,
  ) {
    super("changed");
  }
}

/** Git's blob id for this content, as `git hash-object` gives it; "" for no file. */
export function blobSha(content: string | null): string {
  if (content === null) return "";
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Lines (or sections) per file Search shows, the best first. */
const LINES_PER_FILE = 3;
/** Files bigger than this aren't indexed for search. */
const INDEX_MAX_BYTES = 1_000_000;

/** A file's sections, split at markdown headings outside code blocks, each with its first line. */
export function sections(content: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let lines: string[] = [];
  let start = 1;
  let fence = false;
  content.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence && /^#{1,6}\s/.test(l) && lines.length) {
      out.push({ line: start, text: lines.join("\n") });
      lines = [];
      start = i + 1;
    }
    lines.push(l);
  });
  out.push({ line: start, text: lines.join("\n") });
  return out.filter((s) => s.text.trim());
}

/**
 * The line of a section highlighted with \x02 and \x03 that has the most matches, the first on a tie,
 * cut to 300 characters around its first match.
 */
function bestLine(marked: string, first: number): { line: number; text: string } {
  const lines = marked.split("\n");
  let best = 0;
  let most = -1;
  lines.forEach((l, i) => {
    const n = l.split("\x02").length - 1;
    if (n > most) [best, most] = [i, n];
  });
  const line = lines[best] ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the markers are control characters.
  const text = line.replace(/[\x02\x03]/g, "");
  const at = line.indexOf("\x02");
  const from = at > 200 ? at - 100 : 0;
  return { line: first + best, text: `${from ? "…" : ""}${text.slice(from, from + 300)}` };
}

export class MemoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * With `db`, search ranks sections through its full-text index, which every commit keeps current.
   * With `events`, every commit is told as memory.committed.
   */
  constructor(
    readonly dir: string,
    private db?: Db,
    private events?: EventBus,
  ) {}

  /** Creates the repo if it doesn't exist (the brain's provisioning normally does this). */
  async init() {
    mkdirSync(this.dir, { recursive: true });
    // A git killed mid-write (a crash, a full disk) leaves its lock, and every write after fails on
    // it. The brain is the only writer, so one there at start is stale.
    const lock = join(this.dir, ".git", "index.lock");
    if (existsSync(lock)) {
      console.warn(`memory: removed a stale ${lock}`);
      await rm(lock, { force: true });
    }
    if ((await this.git(["rev-parse", "--is-inside-work-tree"], { allowFail: true })).code !== 0) {
      await this.git(["init", "-q", "-b", "main"]);
      await writeFile(join(this.dir, "INDEX.md"), "# Memory index\n");
      await this.git(["add", "-A"]);
      await this.commitAs(HATBOT, "Start memory");
    }
    // From scratch: files edited by hand outside Hatbot are indexed as they are now.
    if (this.db) {
      this.db.run("DELETE FROM memory_fts");
      await this.index((await this.tree()).map((f) => f.path));
    }
  }

  /** Puts these files' sections in the search index as they are now: a missing file drops out. */
  private async index(paths: string[]) {
    const db = this.db;
    if (!db) return;
    const files: { path: string; content: string | null }[] = [];
    for (const path of paths) {
      let content: string | null = null;
      try {
        const { abs } = this.resolve(path);
        if ((await stat(abs)).size <= INDEX_MAX_BYTES) content = await readFile(abs, "utf8");
      } catch {}
      files.push({ path, content: content?.includes("\0") ? null : content });
    }
    const drop = db.query("DELETE FROM memory_fts WHERE path = ?");
    const add = db.query("INSERT INTO memory_fts (path, line, text) VALUES (?, ?, ?)");
    db.transaction(() => {
      for (const f of files) {
        drop.run(f.path);
        for (const s of f.content === null ? [] : sections(f.content))
          add.run(f.path, s.line, s.text);
      }
    })();
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
      throw new MemoryError(`not found: ${path}`, 404);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      return (await stat(this.resolve(path).abs)).isFile();
    } catch {
      return false;
    }
  }

  /** A file's content, or null when there's no such file. */
  async readOrNull(path: string): Promise<string | null> {
    return (await this.exists(path)) ? this.read(path) : null;
  }

  /** Writes a file and commits it. Returns the commit, or null if the content didn't change. */
  write(path: string, content: string, author: Author, message: string): Promise<string | null> {
    return this.writeAll([{ path, content }], author, message);
  }

  /**
   * Reads, then writes, with no other write in between: `fn` reads what it needs (null for a file
   * that doesn't exist) and returns the files to write or delete, or null to change nothing.
   */
  edit(
    fn: (
      read: (path: string) => Promise<string | null>,
    ) => Promise<{ path: string; content: string | null }[] | null>,
    author: Author,
    message: string,
  ): Promise<string | null> {
    return this.serial(async () => {
      const files = await fn((path) => this.readOrNull(path));
      return files ? this.apply(files, author, message) : null;
    });
  }

  private async apply(
    files: { path: string; content: string | null }[],
    author: Author,
    message: string,
  ) {
    // Every path checked before anything is written; any file can be deleted.
    const resolved = files.map((f) => ({
      ...this.resolve(f.path, { markdown: f.content !== null }),
      ...f,
    }));
    // Each file as it was, edits not committed too, to put back if the change fails partway.
    const before = new Map<string, Buffer | null>();
    const staged: string[] = [];
    try {
      for (const { rel, abs, content } of resolved) {
        const was = await readFile(abs).catch(() => null);
        if (content === null && was === null) continue;
        before.set(rel, was);
        if (content === null) {
          await rm(abs);
          // A file that was never committed (made by hand) has nothing to stage.
          if ((await this.git(["rm", "--cached", "--ignore-unmatch", "--", rel])).stdout.trim())
            staged.push(rel);
        } else {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, content.endsWith("\n") ? content : `${content}\n`);
          await this.git(["add", "--", rel]);
          staged.push(rel);
        }
      }
      return await this.commitAs(author, message, staged);
    } catch (err) {
      await this.restore(before);
      throw err;
    }
  }

  /**
   * After a change that failed partway: the files it touched as they were before it, and none of it
   * staged, so the next commit doesn't carry half of it.
   */
  private async restore(before: Map<string, Buffer | null>) {
    for (const [rel, content] of before) {
      await this.git(["reset", "-q", "--", rel], { allowFail: true });
      const abs = join(this.dir, rel);
      if (content === null) await rm(abs, { force: true });
      else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      }
    }
  }

  /** Writes several files in one commit. */
  writeAll(
    files: { path: string; content: string }[],
    author: Author,
    message: string,
  ): Promise<string | null> {
    return this.serial(() => this.apply(files, author, message));
  }

  /**
   * Reads a file, changes it with `fn`, and writes it back, with no other write in between. `fn` gets
   * null for a file that doesn't exist yet, and returns null to leave it as it is. Returns the commit.
   */
  update(
    path: string,
    fn: (current: string | null) => string | null | Promise<string | null>,
    author: Author,
    message: string,
  ): Promise<string | null> {
    return this.edit(
      async (read) => {
        const next = await fn(await read(path));
        return next === null ? null : [{ path, content: next }];
      },
      author,
      message,
    );
  }

  /**
   * Writes a file unless it changed since it was read as `baseSha` ("" if it didn't exist then).
   * Throws MemoryConflict with what it is now.
   */
  writeIf(
    path: string,
    content: string,
    baseSha: string,
    author: Author,
    message: string,
  ): Promise<string | null> {
    return this.update(
      path,
      (current) => {
        const sha = blobSha(current);
        if (sha !== baseSha) throw new MemoryConflict(sha, current ?? "");
        return content;
      },
      author,
      message,
    );
  }

  delete(path: string, author: Author, message: string): Promise<string | null> {
    return this.serial(async () => {
      const { rel } = this.resolve(path);
      if (!(await this.exists(rel))) throw new MemoryError(`not found: ${path}`, 404);
      return this.apply([{ path: rel, content: null }], author, message);
    });
  }

  /**
   * Sections with any of the words, in any form ("runs" finds "run"), the best match first, each as
   * its line with the most of them. Without the index, or if it fails, lines with every word.
   */
  async search(query: string, limit = 50): Promise<MemoryHit[]> {
    const fts = this.db && ftsQuery(query, " OR ");
    if (fts && this.db) {
      try {
        const rows = this.db
          .query<{ path: string; line: number; marked: string }, [string, number]>(
            `SELECT path, line, highlight(memory_fts, 2, '\x02', '\x03') AS marked FROM memory_fts
             WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`,
          )
          .all(fts, limit * LINES_PER_FILE);
        const perFile = new Map<string, number>();
        return rows
          .filter((r) => {
            perFile.set(r.path, (perFile.get(r.path) ?? 0) + 1);
            return (perFile.get(r.path) ?? 0) <= LINES_PER_FILE;
          })
          .slice(0, limit)
          .map((r) => ({ path: r.path, ...bestLine(r.marked, r.line) }));
      } catch (err) {
        console.error("memory search fell back to grep", err);
      }
    }
    return this.grep(query, limit);
  }

  /**
   * Files with every word somewhere in them, the ones with the most matching lines first, and in each
   * the lines with the most of the words.
   */
  private async grep(query: string, limit: number): Promise<MemoryHit[]> {
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 10);
    if (!words.length) return [];
    const res = await this.git(
      [
        "grep",
        "-n",
        "-I",
        "-i",
        "-F",
        "--all-match",
        ...words.flatMap((w) => ["-e", w]),
        "--",
        ".",
      ],
      { allowFail: true },
    );
    const files = new Map<string, { hit: MemoryHit; words: number }[]>();
    for (const line of res.stdout.split("\n")) {
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const text = m[3] as string;
      const lower = text.toLowerCase();
      const hit = { path: m[1] as string, line: Number(m[2]), text: text.slice(0, 300) };
      const found = words.filter((w) => lower.includes(w)).length;
      const list = files.get(hit.path) ?? [];
      list.push({ hit, words: found });
      files.set(hit.path, list);
    }
    return [...files.values()]
      .sort(
        (a, b) => b.length - a.length || (a[0]?.hit.path ?? "").localeCompare(b[0]?.hit.path ?? ""),
      )
      .flatMap((lines) =>
        lines
          .sort((a, b) => b.words - a.words || a.hit.line - b.hit.line)
          .slice(0, LINES_PER_FILE)
          .map((l) => l.hit),
      )
      .slice(0, limit);
  }

  /** Files changed outside Hatbot and not committed, e.g. edited by hand on the brain. */
  async uncommitted(): Promise<string[]> {
    const res = await this.git(["status", "--porcelain"]);
    return res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
  }

  /** Newest first; `skip` that many for the next page. */
  async log(limit = 50, path?: string, skip = 0): Promise<Commit[]> {
    const args = ["log", `-n${limit}`, `--skip=${skip}`, "--format=%x1e%H%x1f%an%x1f%aI%x1f%s"];
    args.push("--name-only");
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
      const files = await this.changedIn(sha);
      // Edits not committed (by hand, on the brain) to a file it touches would block it or be lost.
      const dirty = files.length
        ? (await this.git(["status", "--porcelain", "--", ...files])).stdout
            .split("\n")
            .filter(Boolean)
            .map((l) => l.slice(3))
        : [];
      if (dirty.length)
        throw new MemoryError(`can't revert: ${dirty[0]} has changes that aren't committed`);
      const res = await this.git(["revert", "--no-commit", sha], { allowFail: true });
      if (res.code !== 0) {
        await this.git(["revert", "--abort"], { allowFail: true });
        throw new MemoryError("can't revert: later changes touch the same lines");
      }
      const subject = (await this.git(["log", "-1", "--format=%s", sha])).stdout.trim();
      try {
        return await this.commitAs(author, `Revert "${subject}"`, files);
      } catch (err) {
        // Not left applied and staged, for the next commit to carry.
        await this.git(["revert", "--abort"], { allowFail: true });
        throw err;
      }
    });
  }

  /** The files a commit changed. */
  private async changedIn(sha: string): Promise<string[]> {
    const res = await this.git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]);
    return res.stdout.split("\n").filter(Boolean);
  }

  private checkSha(sha: string) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new MemoryError("invalid commit");
  }

  /** Commits what's staged; with `paths`, only those, so nothing else staged is swept in. */
  private async commitAs(
    author: Author,
    message: string,
    paths?: string[],
  ): Promise<string | null> {
    if (paths && !paths.length) return null;
    const only = paths ? ["--", ...paths] : [];
    if ((await this.git(["diff", "--cached", "--quiet", ...only], { allowFail: true })).code === 0)
      return null;
    await this.git(["commit", "-q", "-m", message, ...only], {
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: HATBOT.name,
        GIT_COMMITTER_EMAIL: HATBOT.email,
      },
    });
    const sha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    if (this.db) {
      // The commit stands even if the index can't follow; search falls back to grep if it's broken.
      await this.index(await this.changedIn(sha)).catch((err) =>
        console.error("memory index update failed", err),
      );
    }
    this.events?.emit({ type: "memory.committed", sha, message, author: author.name });
    return sha;
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
