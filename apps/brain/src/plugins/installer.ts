// Plugins from elsewhere: a git repository at a pinned commit, fetched into data/installed/<id> and
// loaded when the brain starts. They run inside the brain with all it has, so only you add them.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { type Plugin, PluginError, SDK_VERSION } from "@hatbot/plugin-sdk";
import { z } from "zod";
import type { Db } from "../db";
import { broken, problemWith } from "./registry";

const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9]{1,20}$/;
const RUN_MS = 5 * 60_000;

/** A plugin in plugins.json, which Settings offers to install. */
const IndexEntry = z.object({
  id: z.string().regex(ID),
  name: z.string().min(1),
  description: z.string(),
  url: z.string().url(),
  commit: z.string().regex(COMMIT),
});
type IndexEntry = z.infer<typeof IndexEntry>;

type Installed = { id: string; url: string; commit: string; installedAt: string };

export type InstallerDeps = {
  db: Db;
  /** data/installed */
  dir: string;
  /** The plugins Hatbot comes with, which one installed must fit beside. */
  builtIn: () => Plugin[];
  /** The services the core provides itself. */
  coreServices: string[];
  clock?: () => number;
  /** Repositories on this machine too, by path: for tests. */
  local?: boolean;
};

async function run(cmd: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  const p = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? cwd,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const timer = setTimeout(() => p.kill(), RUN_MS);
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  clearTimeout(timer);
  return { ok: (await p.exited) === 0, output: `${out}${err}`.trim() };
}

const PACKAGES = resolve(import.meta.dir, "../../../../packages");

const lastLine = (s: string) => s.split("\n").filter(Boolean).at(-1) ?? "";

/** The module's plugin: its default export, or the one export that is one. */
function pluginIn(mod: Record<string, unknown>): Plugin | null {
  const looks = (v: unknown): v is Plugin =>
    !!v &&
    typeof v === "object" &&
    typeof (v as Plugin).id === "string" &&
    typeof (v as Plugin).start === "function" &&
    typeof (v as Plugin).config?.safeParse === "function";
  if (looks(mod.default)) return mod.default;
  const found = Object.values(mod).filter(looks);
  return found.length === 1 ? (found[0] as Plugin) : null;
}

/** The entry file package.json names, inside `dir`. */
function entryOf(dir: string): string {
  let pkg: { exports?: unknown; module?: unknown; main?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    throw new PluginError("It has no package.json.");
  }
  const exp = pkg.exports;
  const named =
    typeof exp === "string"
      ? exp
      : exp && typeof exp === "object" && typeof (exp as Record<string, unknown>)["."] === "string"
        ? ((exp as Record<string, unknown>)["."] as string)
        : typeof pkg.module === "string"
          ? pkg.module
          : typeof pkg.main === "string"
            ? pkg.main
            : "src/index.ts";
  const path = resolve(dir, named);
  if (!path.startsWith(resolve(dir) + sep)) throw new PluginError("Its entry is outside it.");
  if (!existsSync(path)) throw new PluginError(`Its entry, ${named}, isn't there.`);
  return path;
}

export class Installer {
  private clock: () => number;

  constructor(private d: InstallerDeps) {
    this.clock = d.clock ?? Date.now;
  }

  list(): Installed[] {
    return this.d.db
      .query<Installed, []>(
        "SELECT id, url, commit_sha AS 'commit', installed_at AS installedAt FROM installed_plugins ORDER BY id",
      )
      .all();
  }

  get(id: string): Installed | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  /** Fetches it, checks it's a plugin for this Hatbot, and keeps it; it loads on the next start. */
  async install(url: string, commit: string): Promise<{ id: string; name: string }> {
    const local = this.d.local && url.startsWith("/");
    if (!local && !/^https:\/\/[^\s]+$/.test(url))
      throw new PluginError("Give the repository's https address.");
    if (!COMMIT.test(commit)) throw new PluginError("Give the commit's whole 40-character hash.");
    mkdirSync(this.d.dir, { recursive: true });
    const tmp = join(this.d.dir, `.new-${randomUUID()}`);
    mkdirSync(tmp);
    try {
      await this.fetch(local ? `file://${url}` : url, commit, tmp);
      await this.prepare(tmp);
      const plugin = await this.check(tmp);
      if (this.get(plugin.id))
        throw new PluginError(`There's a plugin called "${plugin.id}" already.`);
      renameSync(tmp, join(this.d.dir, plugin.id));
      this.d.db
        .query(
          "INSERT INTO installed_plugins (id, url, commit_sha, installed_at) VALUES (?, ?, ?, ?)",
        )
        .run(plugin.id, url, commit, new Date(this.clock()).toISOString());
      return { id: plugin.id, name: plugin.name };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Its files go; what it kept (settings, secrets, its folder of data) stays. */
  uninstall(id: string) {
    if (!this.get(id)) throw new PluginError("It comes with Hatbot: switch it off instead.");
    rmSync(join(this.d.dir, id), { recursive: true, force: true });
    this.d.db.query("DELETE FROM installed_plugins WHERE id = ?").run(id);
  }

  /** Each installed plugin, or one that says why it couldn't be loaded. */
  async load(): Promise<Plugin[]> {
    const out: Plugin[] = [];
    for (const row of this.list()) {
      if (this.d.builtIn().some((p) => p.id === row.id)) {
        console.error(`installed plugin ${row.id} has a built-in one's name; not loaded`);
        continue;
      }
      const dir = join(this.d.dir, row.id);
      try {
        if (!existsSync(dir)) throw new PluginError("its files are gone. Install it again.");
        // Again each start: the brain's packages move with each release.
        this.link(dir);
        const plugin = pluginIn(await import(entryOf(dir)));
        if (!plugin) throw new PluginError("it doesn't export a plugin.");
        if (plugin.id !== row.id) throw new PluginError(`it's called "${plugin.id}" now.`);
        out.push(plugin);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`installed plugin ${row.id} not loaded`, err);
        out.push(broken(row.id, row.url, why));
      }
    }
    return out;
  }

  private async fetch(url: string, commit: string, dir: string) {
    const git = (...args: string[]) => run(["git", ...args], dir);
    await git("init", "-q");
    // By hash, which the forges allow; failing that, all of its branches.
    let got = await git("fetch", "-q", "--depth", "1", "--no-tags", url, commit);
    if (!got.ok)
      got = await git("fetch", "-q", "--no-tags", url, "+refs/heads/*:refs/remotes/origin/*");
    if (!got.ok) throw new PluginError(`Couldn't fetch it: ${lastLine(got.output)}`);
    const out = await git("-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit);
    if (!out.ok) throw new PluginError("That commit isn't in the repository.");
    rmSync(join(dir, ".git"), { recursive: true, force: true });
  }

  /** Its own dependencies, without running their scripts; Hatbot's packages are the brain's. */
  private async prepare(dir: string) {
    const path = join(dir, "package.json");
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new PluginError("It has no package.json.");
    }
    const deps = Object.fromEntries(
      Object.entries((pkg.dependencies ?? {}) as Record<string, string>).filter(
        ([name]) => !name.startsWith("@hatbot/"),
      ),
    );
    writeFileSync(
      path,
      JSON.stringify({ ...pkg, dependencies: deps, devDependencies: {}, peerDependencies: {} }),
    );
    // Only what's installed here: a repository may carry its own.
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    if (Object.keys(deps).length) {
      const out = await run(
        [
          process.execPath,
          "install",
          "--production",
          "--ignore-scripts",
          // The service can't write to a home directory.
          "--cache-dir",
          join(this.d.dir, ".cache"),
        ],
        dir,
      );
      if (!out.ok) throw new PluginError(`Its packages didn't install: ${lastLine(out.output)}`);
    }
    this.link(dir);
  }

  private link(dir: string) {
    const scope = join(dir, "node_modules", "@hatbot");
    mkdirSync(scope, { recursive: true });
    for (const [name, target] of [
      ["plugin-sdk", join(PACKAGES, "plugin-sdk")],
      ["shared", join(PACKAGES, "shared")],
    ] as const) {
      const at = join(scope, name);
      rmSync(at, { recursive: true, force: true });
      mkdirSync(dirname(at), { recursive: true });
      symlinkSync(target, at, "dir");
    }
  }

  private async check(dir: string): Promise<Plugin> {
    let mod: Record<string, unknown>;
    try {
      mod = await import(entryOf(dir));
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError(
        `It didn't load: ${lastLine(err instanceof Error ? err.message : String(err))}`,
      );
    }
    const plugin = pluginIn(mod);
    if (!plugin) throw new PluginError("It doesn't export a plugin.");
    if ((plugin.sdk ?? SDK_VERSION) !== SDK_VERSION)
      throw new PluginError(
        `It's made for version ${plugin.sdk} of Hatbot's plugin API; this Hatbot has ${SDK_VERSION}.`,
      );
    const why = problemWith(plugin, this.d.builtIn(), this.d.coreServices);
    if (why) throw new PluginError(`${why[0]?.toUpperCase()}${why.slice(1)}.`);
    return plugin;
  }
}

/** plugins.json, the plugins Settings offers; one that isn't right is left out. */
export function pluginIndex(
  path = resolve(import.meta.dir, "../../../../plugins.json"),
): IndexEntry[] {
  try {
    const list = JSON.parse(readFileSync(path, "utf8"));
    return (Array.isArray(list) ? list : []).flatMap((e) => {
      const r = IndexEntry.safeParse(e);
      return r.success ? [r.data] : [];
    });
  } catch {
    return [];
  }
}
