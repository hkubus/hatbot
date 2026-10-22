// The brain keeps a bare clone and never runs the code: what changed in the sandbox comes back as a
// diff, which git applies to an index without running anything in it. The sandbox never sees the
// token: git sends it in a header, never in a URL or a file.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import { PluginError } from "./plugin";

export const MAX_PATCH_BYTES = 5_000_000;
/** The desktop takes files of up to 25 MB, so the files go in parts and are joined in the sandbox. */
const PART_BYTES = 24 * 1024 * 1024;
const MAX_FILES_BYTES = 200 * 1024 * 1024;

/** git's environment: no config but its own, and never asking for a password. */
const gitEnv = (dir: string, env: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? dir,
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  ...env,
});

export async function git(
  dir: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: Uint8Array } = {},
): Promise<Uint8Array> {
  const p = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: gitEnv(dir, opts.env),
    stdin: opts.stdin ? new Blob([opts.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).bytes(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new PluginError(`git ${args[0]} failed: ${err.trim().slice(0, 500)}`);
  return out;
}
export const gitText = async (...a: Parameters<typeof git>) =>
  new TextDecoder().decode(await git(...a));

export type Change = { mode: string; status: string; path: string };

/** `git diff-tree -r -z` as [new mode, status, path] per file. */
function rawChanges(raw: string) {
  const parts = raw.split("\0").filter(Boolean);
  const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [, mode = "", , , status = ""] = (parts[i] ?? "").slice(1).split(" ");
    out.push({ mode, status, path: parts[i + 1] ?? "" });
  }
  return out;
}

/** git's settings for a remote that takes `authorization`: a header of its own requests only. */
export const remoteEnv = (authorization: string) => ({
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  GIT_CONFIG_KEY_1: "http.followRedirects",
  GIT_CONFIG_VALUE_1: "false",
});
export const basicAuth = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

/** A word for the shell, quoted: branch names may hold $, ; and the like. */
const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export type Checkout = {
  cache: string;
  url: string;
  remote: () => Promise<Record<string, string>>;
  /** The checkout, relative to the sandbox's home. */
  work: string;
  scratch: string;
  /** The tool that checks it out, for when there's no checkout. */
  tool: string;
};

export const intoCheckout = (c: Checkout) =>
  `cd ${c.work} 2>/dev/null || { echo "There's no checkout: call ${c.tool} first."; exit 2; }`;

export function serially() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => {});
    return next;
  };
}

/** The sandbox's errors are fine to show. */
const inSandbox = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (err) {
    throw err instanceof DesktopError ? new PluginError(err.message) : err;
  }
};

/** Fetches only the branches checked out. */
export async function fetchBranch(c: Checkout, branch: string): Promise<string> {
  if (!existsSync(join(c.cache, "HEAD"))) {
    await mkdir(c.cache, { recursive: true });
    await git(c.cache, ["init", "--bare", "--quiet"]);
  }
  const refspec = `+refs/heads/${branch}:refs/heads/${branch}`;
  await git(c.cache, ["fetch", "--quiet", c.url, refspec], { env: await c.remote() });
  return (await gitText(c.cache, ["rev-parse", `refs/heads/${branch}^{commit}`])).trim();
}

export async function remoteHead(c: Checkout, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const out = await gitText(c.cache, ["ls-remote", c.url, ref], { env: await c.remote() });
  // ls-remote matches the end of a ref's name, so refs/heads/x/refs/heads/main would do for main.
  const line = out.split("\n").find((l) => l.endsWith(`\t${ref}`));
  return line?.split("\t")[0] ?? null;
}

/** Throws unless the bare clone has `sha`, as it has the commit a checkout came from. */
export async function mustHave(c: Checkout, sha: string) {
  const has =
    existsSync(join(c.cache, "HEAD")) &&
    (await git(c.cache, ["cat-file", "-e", `${sha}^{commit}`]).then(
      () => true,
      () => false,
    ));
  if (!has)
    throw new PluginError("The checkout's commit isn't in the repository: check out again.");
}

/** Past 200 MB it stops and refuses. */
export async function archive(c: Checkout, sha: string): Promise<Uint8Array> {
  const p = Bun.spawn(["git", "archive", "--format=tar.gz", sha], {
    cwd: c.cache,
    env: gitEnv(c.cache),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = new Response(p.stderr).text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of p.stdout) {
    size += chunk.length;
    if (size > MAX_FILES_BYTES) {
      p.kill();
      throw new PluginError(
        "Its files come to over 200 MB compressed, more than the sandbox takes.",
      );
    }
    chunks.push(chunk);
  }
  if ((await p.exited) !== 0)
    throw new PluginError(`git archive failed: ${(await err).trim().slice(0, 500)}`);
  return Buffer.concat(chunks);
}

/**
 * A fresh git repository whose one commit, tagged base, says the commit and branch the files came from.
 * `before` runs before the old checkout goes; `after`, in the new one.
 */
export async function putCheckout(
  shell: DesktopAgent,
  c: Checkout,
  o: {
    tar: Uint8Array;
    sha: string;
    branch: string;
    before?: string[];
    after: string[];
    timeoutS: number;
  },
): Promise<string> {
  const parts: string[] = [];
  for (let at = 0; at < o.tar.length; at += PART_BYTES)
    parts.push(`${c.scratch}/files.tar.gz.${String(parts.length).padStart(2, "0")}`);
  const r = await inSandbox(async () => {
    for (const [i, part] of parts.entries())
      await shell.putFile(part, o.tar.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
    return shell.exec(
      [
        "set -e",
        `trap 'cd && rm -f ${parts.join(" ")}' EXIT`,
        ...(o.before ?? []),
        `rm -rf ${c.work} ${c.scratch}/change.patch`,
        `mkdir -p ${c.work}`,
        `cat ${parts.join(" ")} | tar -xzf - -C ${c.work}`,
        `cd ${c.work}`,
        "git init -q -b work",
        "git add -A",
        `git -c user.name=Hatbot -c user.email=hatbot@localhost commit -q -m ${o.sha} -m ${quoted(o.branch)}`,
        "git tag base",
        ...o.after,
      ].join("\n"),
      o.timeoutS,
    );
  });
  if (r.timedOut || r.exitCode !== 0) throw new PluginError(`The checkout failed.\n${r.output}`);
  return r.output.trim();
}

export async function checkoutDiff(shell: DesktopAgent, c: Checkout) {
  const patchPath = `${c.scratch}/change.patch`;
  const fromWork = (path: string) => posix.relative(c.work, path);
  const { r, patch } = await inSandbox(async () => {
    const r = await shell.exec(
      `${intoCheckout(c)}\nmkdir -p ${fromWork(c.scratch)} && git add -A && git diff --cached --binary --full-index base > ${fromWork(patchPath)} && git log -1 --format='base: %s %b' base`,
      120,
    );
    if (r.exitCode !== 0) throw new PluginError(r.output.trim() || "The diff failed.");
    return { r, patch: await shell.getFile(patchPath) };
  });
  // Its own line comes first: what git said on standard error follows.
  const [, from = "", branch = ""] = /^base: ([0-9a-f]{40}) ?(\S*)/m.exec(r.output) ?? [];
  if (!from) throw new PluginError("The checkout doesn't say what it came from: check out again.");
  if (!patch.length) throw new PluginError("Nothing changed in the checkout.");
  if (patch.length > MAX_PATCH_BYTES)
    throw new PluginError("The change is over 5 MB: make it smaller.");
  return { patch, from, branch };
}

/** Never forces. Symlinks and submodules are refused before anything is pushed. Run it serially. */
export async function commitAndPush(
  c: Checkout,
  o: {
    from: string;
    patch: Uint8Array;
    message: string;
    branch: string;
    who: { name: string; email: string };
    prepare: () => Promise<void>;
    check?: (files: Change[]) => void;
    /** What can't be done to a symlink: proposed, pushed. */
    verb: string;
  },
) {
  const { from, patch, who } = o;
  await o.prepare();
  await mustHave(c, from);
  const tmp = await mkdtemp(join(dirname(c.cache), "index-"));
  try {
    const index = { GIT_INDEX_FILE: join(tmp, "index") };
    await git(c.cache, ["read-tree", from], { env: index });
    await git(c.cache, ["apply", "--cached", "--whitespace=nowarn", "-"], {
      env: index,
      stdin: patch,
    });
    const tree = (await gitText(c.cache, ["write-tree"], { env: index })).trim();
    const commit = (
      await gitText(c.cache, ["commit-tree", tree, "-p", from, "-m", o.message], {
        env: {
          GIT_AUTHOR_NAME: who.name,
          GIT_AUTHOR_EMAIL: who.email,
          GIT_COMMITTER_NAME: who.name,
          GIT_COMMITTER_EMAIL: who.email,
        },
      })
    ).trim();
    const files = rawChanges(
      await gitText(c.cache, ["diff-tree", "-r", "-z", "--no-renames", from, commit]),
    );
    const odd = files.filter((f) => f.mode === "120000" || f.mode === "160000");
    if (odd.length)
      throw new PluginError(
        `Symlinks and submodules can't be ${o.verb}: ${odd.map((f) => f.path).join(", ")}`,
      );
    o.check?.(files);
    const stat = (await gitText(c.cache, ["diff", "--shortstat", from, commit])).trim();
    await git(c.cache, ["push", "--quiet", c.url, `${commit}:refs/heads/${o.branch}`], {
      env: await c.remote(),
    });
    return { commit, stat, files };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** After a push, so the next diff starts from it; what changed since stays a change. */
export async function moveBase(shell: DesktopAgent, c: Checkout, commit: string, branch: string) {
  const r = await inSandbox(() =>
    shell.exec(
      `${intoCheckout(c)}\ngit -c user.name=Hatbot -c user.email=hatbot@localhost commit -q --allow-empty --no-verify -m ${commit} -m ${quoted(branch)} && git tag -f base >/dev/null`,
      120,
    ),
  );
  if (r.timedOut || r.exitCode !== 0) throw new PluginError(r.output.trim() || "git failed.");
}
