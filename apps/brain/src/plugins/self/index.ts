// Own code (PLAN.md §18): Hatbot's own repository on Forgejo. self_checkout puts the default branch into
// the desktop's sandbox, self_run reads, changes and tests it there, and self_propose turns what changed
// into a branch and a pull request that the owner reviews and merges. The brain never runs that code:
// it keeps a bare clone, applies the sandbox's diff to an index with git, which runs nothing, and pushes.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type DesktopAgent, DesktopError } from "../../desktop/client";
import { Branch, Repo, repoPath, validRef } from "../forge";
import { definePlugin, httpApi, needsSetup, PluginError, ready, tool } from "../plugin";

const WORK = "hatbot-self/work";
const PATCH = "hatbot-self/change.patch";
const MAX_PATCH_BYTES = 5_000_000;
const NO_CHECKOUT = `cd ${WORK} 2>/dev/null || { echo "There's no checkout: call self_checkout first."; exit 2; }`;
/**
 * Paths that run as root on the brain once merged and updated, run in CI, or bring in other code. The
 * pull request names them, so the owner reads them closely.
 */
const CAREFUL = [
  /^infra\//,
  /^\.(forgejo|gitea|github)\//,
  /^scripts\//,
  /(^|\/)package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
];

/** git with no config but its own, never asking for a password. */
async function git(
  dir: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: Uint8Array } = {},
): Promise<Uint8Array> {
  const p = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? dir,
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...opts.env,
    },
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
const text = async (...a: Parameters<typeof git>) => new TextDecoder().decode(await git(...a));

/** `git diff-tree -r -z` as [new mode, status, path] per file. */
function rawChanges(raw: string) {
  const parts = raw.split("\0").filter(Boolean);
  const out: { mode: string; status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [, mode = "", , , status = ""] = (parts[i] ?? "").slice(1).split(" ");
    out.push({ mode, status, path: parts[i + 1] ?? "" });
  }
  return out;
}

export const selfPlugin = (d: { desktop: DesktopAgent; dir: string }) =>
  definePlugin({
    id: "self",
    name: "Own code",
    description: "Read and test Hatbot's own code, and propose changes as Forgejo pull requests",
    secrets: ["FORGEJO_URL", "FORGEJO_TOKEN", "HATBOT_SELF_REPO"],
    config: z.object({}),
    start: ({ env }) => {
      if (!d.desktop.configured)
        return needsSetup("The desktop isn't set up yet; Hatbot reads and tests its code there.");
      const base = env.FORGEJO_URL?.replace(/\/$/, "");
      const token = env.FORGEJO_TOKEN;
      const repo = env.HATBOT_SELF_REPO ?? "";
      if (!base || !token || !Repo("").safeParse(repo).success)
        return needsSetup(
          "Put HATBOT_SELF_REPO, Hatbot's repository as owner/name, next to FORGEJO_URL and FORGEJO_TOKEN in /etc/hatbot/forgejo.env on the brain, then restart it. The bot account needs write access to that repository, to push branches.",
        );
      const gitUrl = env.HATBOT_SELF_GIT_URL ?? `${base}/${repo}.git`;
      const cache = join(d.dir, "repo.git");
      const { api } = httpApi("Forgejo", `${base}/api/v1`, {
        authorization: `token ${token}`,
        accept: "application/json",
      });

      let me: { login: string; email: string } | null = null;
      const user = async () => {
        me ??= await api<{ login: string; email: string }>("GET", "/user");
        return me;
      };
      const remote = async () => {
        const { login } = await user();
        return {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`${login}:${token}`)}`,
          GIT_CONFIG_KEY_1: "http.followRedirects",
          GIT_CONFIG_VALUE_1: "false",
        };
      };
      const defaultBranch = async () => {
        const { default_branch } = await api<{ default_branch: string }>("GET", repoPath(repo));
        if (!validRef(default_branch))
          throw new PluginError(`Forgejo names an odd default branch: ${default_branch}`);
        return default_branch;
      };
      const fetched = async (branch: string) => {
        const env = await remote();
        if (!existsSync(join(cache, "HEAD"))) {
          await mkdir(d.dir, { recursive: true });
          await git(d.dir, ["clone", "--bare", "--quiet", gitUrl, cache], { env });
        }
        const refspec = `+refs/heads/${branch}:refs/heads/${branch}`;
        await git(cache, ["fetch", "--quiet", gitUrl, refspec], { env });
        return (await text(cache, ["rev-parse", `refs/heads/${branch}^{commit}`])).trim();
      };
      // One task at a time changes the bare clone.
      let queue: Promise<unknown> = Promise.resolve();
      const serial = <T>(f: () => Promise<T>): Promise<T> => {
        const next = queue.then(f, f);
        queue = next.catch(() => {});
        return next;
      };
      const sandbox = (signal: AbortSignal) => d.desktop.withSignal?.(signal) ?? d.desktop;
      const shellError = (err: unknown) =>
        err instanceof DesktopError ? new PluginError(err.message) : err;

      const tools = [
        tool({
          name: "self_checkout",
          description: `Put your own code, ${repo} as its default branch holds it now, in the sandbox at ~/${WORK}, in place of any checkout there, and install its dependencies. Changes are tracked against it for self_propose.`,
          access: "write",
          label: "Checking out its code",
          schema: z.object({}),
          // The sandbox reaches the internet and keeps its files, so what it prints is untrusted.
          untrusted: true,
          describe: () => `Check out ${repo} in the sandbox`,
          run: async (_input, call) => {
            const branch = await defaultBranch();
            const { sha, tar } = await serial(async () => {
              const sha = await fetched(branch);
              return { sha, tar: await git(cache, ["archive", "--format=tar.gz", sha]) };
            });
            try {
              const shell = sandbox(call.signal);
              await shell.putFile("hatbot-self/src.tar.gz", tar);
              const r = await shell.exec(
                [
                  "set -e",
                  `rm -rf ${WORK} ${PATCH}`,
                  `mkdir -p ${WORK}`,
                  `tar -xzf hatbot-self/src.tar.gz -C ${WORK}`,
                  "rm hatbot-self/src.tar.gz",
                  `cd ${WORK}`,
                  "git init -q -b work",
                  "git add -A",
                  `git -c user.name=Hatbot -c user.email=hatbot@localhost commit -q -m ${sha}`,
                  "git tag base",
                  `echo "${repo}@${branch} ${sha.slice(0, 10)}: $(git ls-files | wc -l) files in ~/${WORK}"`,
                  "ls -p",
                  "if [ -f bun.lock ]; then bun install --frozen-lockfile 2>&1 | tail -n 3; fi",
                ].join("\n"),
                600,
              );
              if (r.timedOut || r.exitCode !== 0)
                throw new PluginError(`The checkout failed.\n${r.output}`);
              return `${r.output.trim()}\nRead, change and test it with self_run, then self_propose.`;
            } catch (err) {
              throw shellError(err);
            }
          },
        }),
        tool({
          name: "self_run",
          description: `Run a bash command in your checkout (~/${WORK}, from self_checkout), in the sandbox: read and search the code, change files, run the tests. It has git, Bun and Python 3, and reaches the internet but not your LAN.`,
          access: "write",
          label: "Working on its code",
          schema: z.object({
            command: z.string().min(1).max(20_000).describe("A bash command or script"),
            timeout_s: z
              .number()
              .int()
              .min(1)
              .max(600)
              .default(120)
              .describe("Seconds before it's killed"),
          }),
          untrusted: true,
          describe: ({ command }) => {
            const line = command.trim().split("\n")[0] ?? "";
            return line.length > 120 ? `${line.slice(0, 119)}…` : line;
          },
          run: async ({ command, timeout_s }, call) => {
            try {
              const r = await sandbox(call.signal).exec(`${NO_CHECKOUT}\n${command}`, timeout_s);
              const head = r.timedOut ? `Killed after ${timeout_s} s.` : `Exit code ${r.exitCode}`;
              return `${head}\n${r.output}`;
            } catch (err) {
              throw shellError(err);
            }
          },
        }),
        tool({
          name: "self_propose",
          description: `Open a pull request on ${repo} with everything changed in the checkout since self_checkout, on a new branch. The owner reviews and merges it.`,
          access: "write",
          schema: z.object({
            branch: Branch.refine(
              (b) => b.startsWith("hatbot/"),
              'a new branch under hatbot/, e.g. "hatbot/faster-search"',
            ),
            title: z.string().min(1).max(255),
            body: z
              .string()
              .max(20_000)
              .describe(
                "What changed and why, how you tested it (the commands and what they said), and what the owner should check",
              ),
          }),
          describe: ({ branch, title }) => `Open a pull request on ${repo}: ${title} (${branch})`,
          run: async ({ branch, title, body }, call) => {
            let patch: Uint8Array;
            let from: string;
            try {
              const shell = sandbox(call.signal);
              const r = await shell.exec(
                `${NO_CHECKOUT}\ngit add -A && git diff --cached --binary --full-index base > ../change.patch && git log -1 --format=%s base`,
                120,
              );
              if (r.exitCode !== 0) throw new PluginError(r.output.trim() || "The diff failed.");
              from = r.output.trim().split("\n").at(-1) ?? "";
              patch = await shell.getFile(PATCH);
            } catch (err) {
              throw shellError(err);
            }
            if (!/^[0-9a-f]{40}$/.test(from))
              throw new PluginError("The checkout doesn't say what it came from: check out again.");
            if (!patch.length) throw new PluginError("Nothing changed in the checkout.");
            if (patch.length > MAX_PATCH_BYTES)
              throw new PluginError("The change is over 5 MB: make it smaller.");
            const into = await defaultBranch();
            const { login, email } = await user();

            const pushed = await serial(async () => {
              await fetched(into);
              await git(cache, ["cat-file", "-e", `${from}^{commit}`]).catch(() => {
                throw new PluginError(
                  "The checkout's commit isn't in the repository: check out again.",
                );
              });
              const tmp = await mkdtemp(join(d.dir, "index-"));
              try {
                const index = { GIT_INDEX_FILE: join(tmp, "index") };
                await git(cache, ["read-tree", from], { env: index });
                await git(cache, ["apply", "--cached", "--whitespace=nowarn", "-"], {
                  env: index,
                  stdin: patch,
                });
                const tree = (await text(cache, ["write-tree"], { env: index })).trim();
                const who = { name: login, email: email || `${login}@localhost` };
                const commit = (
                  await text(cache, ["commit-tree", tree, "-p", from, "-m", title], {
                    env: {
                      GIT_AUTHOR_NAME: who.name,
                      GIT_AUTHOR_EMAIL: who.email,
                      GIT_COMMITTER_NAME: who.name,
                      GIT_COMMITTER_EMAIL: who.email,
                    },
                  })
                ).trim();
                const files = rawChanges(
                  await text(cache, ["diff-tree", "-r", "-z", "--no-renames", from, commit]),
                );
                const odd = files.filter((f) => f.mode === "120000" || f.mode === "160000");
                if (odd.length)
                  throw new PluginError(
                    `Symlinks and submodules can't be proposed: ${odd.map((f) => f.path).join(", ")}`,
                  );
                const stat = (await text(cache, ["diff", "--shortstat", from, commit])).trim();
                await git(cache, ["push", "--quiet", gitUrl, `${commit}:refs/heads/${branch}`], {
                  env: await remote(),
                });
                return { files, stat };
              } finally {
                await rm(tmp, { recursive: true, force: true });
              }
            });

            const careful = pushed.files
              .map((f) => f.path)
              .filter((p) => CAREFUL.some((re) => re.test(p)));
            const footer = [
              "---",
              `Proposed by Hatbot${call.task ? ` in task #${call.task.id}` : ""}, from ${from.slice(0, 10)}: ${pushed.stat}.`,
              ...(careful.length
                ? [
                    "",
                    "**Read these closely before merging.** Once merged and updated they run as root on the brain, run in CI, or bring in other code:",
                    ...careful.map((p) => `- \`${p}\``),
                  ]
                : []),
            ].join("\n");
            try {
              const pr = await api<{ number: number; html_url: string }>(
                "POST",
                `${repoPath(repo)}/pulls`,
                { head: branch, base: into, title, body: body ? `${body}\n\n${footer}` : footer },
              );
              return `Opened pull request #${pr.number}: ${pr.html_url}\n${pushed.stat}${careful.length ? `\nIt touches ${careful.join(", ")}, which the pull request asks the owner to read closely.` : ""}`;
            } catch (err) {
              if (err instanceof PluginError)
                throw new PluginError(
                  `Pushed ${branch}, but the pull request failed: ${err.message}`,
                );
              throw err;
            }
          },
        }),
      ];
      return ready(tools, {
        guidance: `Your own code is ${repo} on Forgejo. Change it only when the owner asks, never on your own initiative, and as a task (run_task, effort high). self_checkout puts it in the sandbox; self_run reads, changes and tests it there (its AGENTS.md or HANDOFF.md, if it has one, says how to build and test; run the tests, lint and typecheck before proposing); self_propose opens a pull request from what changed, one change per pull request. Never merge your own pull requests: the owner reviews and merges them.`,
        test: async () => {
          const { login } = await user();
          const branch = await defaultBranch();
          return `Signed in as ${login}; ${repo}'s default branch is ${branch}.`;
        },
      });
    },
  });
