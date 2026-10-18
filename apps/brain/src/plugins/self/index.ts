// Own code (PLAN.md §18): Hatbot's own repository on Forgejo. self_checkout puts the default branch, or
// one of its own pull requests, into the desktop's sandbox, self_run reads, changes and tests it there,
// and self_propose turns what changed into a branch and a pull request that the owner reviews and
// merges; self_update pushes it onto the pull request that was checked out. The brain never runs that
// code: it keeps a bare clone, applies the sandbox's diff to an index with git, which runs nothing, and
// pushes.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type DesktopAgent, DesktopError } from "../../desktop/client";
import type { Schedules } from "../../schedules";
import { getSetting, setSetting } from "../../settings";
import { Branch, Num, Repo, repoPath, validRef } from "../forge";
import { definePlugin, httpApi, needsSetup, PluginError, ready, tool } from "../plugin";

const WORK = "hatbot-self/work";
const PATCH = "hatbot-self/change.patch";
const MAX_PATCH_BYTES = 5_000_000;
/** How much of a pull request's conversation self_checkout shows. */
const MAX_CONVERSATION = 30_000;
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

/** Branches of suggestions a schedule asked for: one is open at a time. */
const SUGGESTION = "hatbot/suggest/";
const SUGGEST_KEY = "self:suggest";
const SUGGEST_CRON = { weekly: "0 10 * * 1", monthly: "0 10 1 * *" } as const;
const SUGGEST_PROMPT = `Look over your own code and suggest at most one small improvement, as a pull request for the owner to review. The owner set this schedule; only open a pull request if it's clearly worth their time.

1. Call self_checkout. If you don't have it, say the Own code plugin is off and finish. It lists your open pull requests: if one on a ${SUGGESTION} branch is still open, finish and say it's waiting for the owner, without looking further.
2. Read AGENTS.md and PLAN.md, then the code, with self_run. Look for one small change that's clearly better: a bug, a missing check, a confusing or dead piece of code, a slow path. Not a new feature, a rewrite, a new dependency, or anything PLAN.md says was left on purpose, and nothing under infra/, .forgejo/, .github/ or scripts/.
3. Make the change and run the tests, lint and typecheck as AGENTS.md says. If they don't all pass, or you aren't sure it's an improvement, don't propose it.
4. Propose it with self_propose on a branch under ${SUGGESTION}, saying what you found, why it's worth changing and how you tested it. One pull request at most.
5. If nothing is worth changing, finish and say so in a line. Never merge.`;

type Pull = {
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  user: { login: string };
  head: { ref: string; repo?: { full_name: string } | null };
};
type Said = { user: { login: string }; body: string; at: string; lines?: string[] };
type Review = {
  id: number;
  user: { login: string };
  body: string;
  state: string;
  submitted_at: string;
  dismissed?: boolean;
};

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

export const selfPlugin = (d: {
  desktop: DesktopAgent;
  dir: string;
  /** Where the suggestions schedule goes; made after the plugins. */
  schedules: () => Pick<Schedules, "get" | "create" | "update" | "delete">;
}) =>
  definePlugin({
    id: "self",
    name: "Own code",
    description: "Read and test Hatbot's own code, and propose changes as Forgejo pull requests",
    env: [
      { name: "FORGEJO_URL", hint: "https://git.example.com" },
      { name: "FORGEJO_TOKEN", secret: true },
      { name: "HATBOT_SELF_REPO", hint: "owner/hatbot" },
      {
        name: "HATBOT_SELF_GIT_URL",
        optional: true,
        hint: "https://git.example.com/owner/hatbot.git",
      },
    ],
    config: z.object({}),
    start: ({ env, db }) => {
      if (!d.desktop.configured)
        return needsSetup("The desktop isn't set up yet; Hatbot reads and tests its code there.");
      const base = env.FORGEJO_URL?.replace(/\/$/, "");
      const token = env.FORGEJO_TOKEN;
      const repo = env.HATBOT_SELF_REPO ?? "";
      if (!base || !token || !Repo("").safeParse(repo).success)
        return needsSetup(
          "Set HATBOT_SELF_REPO, Hatbot's repository as owner/name, and Forgejo's address and token (the Forgejo plugin's) below. The bot account needs write access to that repository, to push branches.",
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
      const same = (a = "", b = "") => a.toLowerCase() === b.toLowerCase();
      /** A pull request of the bot's own, from a hatbot/ branch of this repository. */
      const mine = (pr: Pull, login: string) =>
        same(pr.user.login, login) &&
        pr.head.ref.startsWith("hatbot/") &&
        validRef(pr.head.ref) &&
        same(pr.head.repo?.full_name, repo);
      const openPulls = async () => {
        const { login } = await user();
        const list = await api<Pull[]>("GET", `${repoPath(repo)}/pulls?state=open&limit=50`);
        return list.filter((pr) => mine(pr, login));
      };
      /** An open pull request Hatbot may push to: its own, on its own hatbot/ branch. */
      const ownPull = async (number: number) => {
        const pr = await api<Pull>("GET", `${repoPath(repo)}/pulls/${number}`);
        if (pr.state !== "open" || pr.merged) throw new PluginError(`#${number} isn't open.`);
        if (!mine(pr, (await user()).login))
          throw new PluginError(
            `#${number} isn't one of your pull requests from a hatbot/ branch of ${repo}, so you can't push to it.`,
          );
        return pr;
      };
      /** A pull request's description, comments and reviews with their line comments, oldest first. */
      const conversation = async (pr: Pull) => {
        const p = repoPath(repo);
        const [comments, reviews] = await Promise.all([
          api<{ user: { login: string }; body: string; created_at: string }[]>(
            "GET",
            `${p}/issues/${pr.number}/comments`,
          ),
          api<Review[]>("GET", `${p}/pulls/${pr.number}/reviews`),
        ]);
        const said: Said[] = comments.map((c) => ({
          user: c.user,
          body: c.body,
          at: c.created_at,
        }));
        for (const r of reviews.filter((r) => !r.dismissed)) {
          const lines = await api<{ path: string; position: number; body: string }[]>(
            "GET",
            `${p}/pulls/${pr.number}/reviews/${r.id}/comments`,
          );
          said.push({
            user: r.user,
            body: `Review (${r.state.toLowerCase().replace(/_/g, " ")})${r.body ? `: ${r.body}` : ""}`,
            at: r.submitted_at,
            lines: lines.map((l) => `${l.path}:${l.position}: ${l.body}`),
          });
        }
        said.sort((a, b) => a.at.localeCompare(b.at));
        const out = [
          `#${pr.number} ${pr.title}`,
          pr.body,
          ...said.flatMap((s) => [
            "",
            `--- ${s.user.login}, ${s.at.slice(0, 16).replace("T", " ")}`,
            s.body,
            ...(s.lines ?? []).map((l) => `  ${l}`),
          ]),
        ].join("\n");
        return out.length > MAX_CONVERSATION ? `${out.slice(0, MAX_CONVERSATION)}\n…` : out;
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

      /** Everything changed in the checkout, and the commit it was checked out from. */
      const checkoutDiff = async (signal: AbortSignal) => {
        let patch: Uint8Array;
        let from: string;
        try {
          const shell = sandbox(signal);
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
        return { patch, from };
      };

      /**
       * Applies `patch` on `from` as a commit by the bot account and pushes it to `branch`, with no
       * force. `prepare` fetches what the commit goes on, and refuses if it can't.
       */
      const commitAndPush = (o: {
        from: string;
        patch: Uint8Array;
        message: string;
        branch: string;
        prepare: () => Promise<void>;
      }) =>
        serial(async () => {
          const { from, patch } = o;
          await o.prepare();
          await git(cache, ["cat-file", "-e", `${from}^{commit}`]).catch(() => {
            throw new PluginError(
              "The checkout's commit isn't in the repository: check out again.",
            );
          });
          const { login, email } = await user();
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
              await text(cache, ["commit-tree", tree, "-p", from, "-m", o.message], {
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
            await git(cache, ["push", "--quiet", gitUrl, `${commit}:refs/heads/${o.branch}`], {
              env: await remote(),
            });
            const careful = files
              .map((f) => f.path)
              .filter((p) => CAREFUL.some((re) => re.test(p)));
            return { commit, stat, careful };
          } finally {
            await rm(tmp, { recursive: true, force: true });
          }
        });

      /** What ends a pull request or its comment: where it came from, its size, what to read closely. */
      const footer = (
        verb: string,
        from: string,
        task: number | undefined,
        pushed: { stat: string; careful: string[] },
      ) =>
        [
          "---",
          `${verb} by Hatbot${task ? ` in task #${task}` : ""}, from ${from.slice(0, 10)}: ${pushed.stat}.`,
          ...(pushed.careful.length
            ? [
                "",
                "**Read these closely before merging.** Once merged and updated they run as root on the brain, run in CI, or bring in other code:",
                ...pushed.careful.map((p) => `- \`${p}\``),
              ]
            : []),
        ].join("\n");
      const carefulLine = (careful: string[], where: string) =>
        careful.length
          ? `\nIt touches ${careful.join(", ")}, which ${where} asks the owner to read closely.`
          : "";

      /** The suggestions schedule, by id and creation time: a deleted schedule's id can come back. */
      const suggestions = () => {
        const [id, created] = (getSetting(db, SUGGEST_KEY) ?? "").split(" ");
        const s = d.schedules().get(Number(id));
        return s && s.createdAt === created ? s : null;
      };

      const tools = [
        tool({
          name: "self_checkout",
          description: `Put your own code in the sandbox at ~/${WORK}, in place of any checkout there, and install its dependencies: ${repo} as its default branch holds it now, or with pull, the latest commit of one of your open pull requests, with its description, comments and reviews. Changes are tracked against it for self_propose, or for self_update to push them to that pull request.`,
          access: "write",
          label: "Checking out its code",
          schema: z.object({
            pull: Num.optional().describe(
              "One of your open pull requests to continue, e.g. to address its review comments",
            ),
          }),
          // The sandbox reaches the internet and keeps its files, so what it prints is untrusted. So
          // are a pull request's comments.
          untrusted: true,
          describe: ({ pull }) => `Check out ${repo}${pull ? `#${pull}` : ""} in the sandbox`,
          run: async ({ pull }, call) => {
            const pr = pull ? await ownPull(pull) : null;
            const branch = pr?.head.ref ?? (await defaultBranch());
            const { sha, tar } = await serial(async () => {
              const sha = await fetched(branch);
              return { sha, tar: await git(cache, ["archive", "--format=tar.gz", sha]) };
            });
            let output: string;
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
              output = r.output.trim();
            } catch (err) {
              throw shellError(err);
            }
            if (pr)
              return `${output}\n\n${await conversation(pr)}\n\nChange it with self_run, then push it to #${pr.number} with self_update.`;
            const open = await openPulls();
            const yours = open.length
              ? `Your open pull requests:\n${open.map((p) => `#${p.number} ${p.head.ref}: ${p.title}`).join("\n")}`
              : "You have no open pull requests.";
            return `${output}\n${yours}\nRead, change and test it with self_run, then self_propose.`;
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
            if (branch.startsWith(SUGGESTION)) {
              const waiting = (await openPulls()).find((p) => p.head.ref.startsWith(SUGGESTION));
              if (waiting)
                throw new PluginError(
                  `Your suggestion #${waiting.number} is still open: suggest another once the owner has merged or closed it.`,
                );
            }
            const { patch, from } = await checkoutDiff(call.signal);
            const into = await defaultBranch();
            const pushed = await commitAndPush({
              from,
              patch,
              message: title,
              branch,
              prepare: async () => {
                await fetched(into);
              },
            });
            const end = footer("Proposed", from, call.task?.id, pushed);
            try {
              const pr = await api<{ number: number; html_url: string }>(
                "POST",
                `${repoPath(repo)}/pulls`,
                { head: branch, base: into, title, body: body ? `${body}\n\n${end}` : end },
              );
              return `Opened pull request #${pr.number}: ${pr.html_url}\n${pushed.stat}${carefulLine(pushed.careful, "the pull request")}`;
            } catch (err) {
              if (err instanceof PluginError)
                throw new PluginError(
                  `Pushed ${branch}, but the pull request failed: ${err.message}`,
                );
              throw err;
            }
          },
        }),
        tool({
          name: "self_update",
          description: `Push everything changed in the checkout since self_checkout with pull as a new commit on that pull request's branch, and comment on it with what changed. Only onto the commit that was checked out: if someone pushed since, check out again.`,
          access: "write",
          schema: z.object({
            pull: Num.describe("The pull request you checked out"),
            message: z
              .string()
              .min(1)
              .max(20_000)
              .describe(
                "The commit message: a first line saying what changed, then which review comments it answers and how you tested it",
              ),
          }),
          describe: ({ pull, message }) =>
            `Push to pull request #${pull} on ${repo}: ${message.trim().split("\n")[0]}`,
          run: async ({ pull, message }, call) => {
            const pr = await ownPull(pull);
            const branch = pr.head.ref;
            const { patch, from } = await checkoutDiff(call.signal);
            const pushed = await commitAndPush({
              from,
              patch,
              message,
              branch,
              prepare: async () => {
                // Fast-forward only: what someone else pushed since isn't undone.
                const head = await fetched(branch);
                if (head !== from)
                  throw new PluginError(
                    `The checkout isn't ${branch}'s latest commit (${head.slice(0, 10)}): it moved since, or this is another checkout. Check out #${pull} again.`,
                  );
              },
            });
            const short = pushed.commit.slice(0, 10);
            try {
              await api("POST", `${repoPath(repo)}/issues/${pull}/comments`, {
                body: `${message}\n\n${footer(`Pushed ${short}`, from, call.task?.id, pushed)}`,
              });
            } catch (err) {
              if (err instanceof PluginError)
                throw new PluginError(
                  `Pushed ${short} to ${branch}, but the comment failed: ${err.message}`,
                );
              throw err;
            }
            return `Pushed ${short} to ${branch} (#${pull}) and commented on it.\n${pushed.stat}${carefulLine(pushed.careful, "the comment")}`;
          },
        }),
      ];
      return ready(tools, {
        guidance: `Your own code is ${repo} on Forgejo. Change it only when the owner asks, or when their suggestions schedule asks you for one, never on your own initiative, and as a task (run_task, effort high). self_checkout puts it in the sandbox; self_run reads, changes and tests it there (its AGENTS.md says how to build and test; run the tests, lint and typecheck before proposing); self_propose opens a pull request from what changed, one change per pull request. To answer review comments on one of your pull requests ("address the comments on #12"), self_checkout with its number, which shows them, then self_update pushes the fix to it. Never merge your own pull requests: the owner reviews and merges them.`,
        test: async () => {
          const { login } = await user();
          const branch = await defaultBranch();
          return `Signed in as ${login}; ${repo}'s default branch is ${branch}.`;
        },
        actions: {
          /** How often the suggestions schedule runs: off, weekly, monthly, or its own cron. */
          suggestions: async () => {
            const s = suggestions();
            if (!s?.enabled || !s.cron) return { every: "off" };
            const every = Object.entries(SUGGEST_CRON).find(([, cron]) => cron === s.cron)?.[0];
            return { every: every ?? "other", cron: s.cron, id: s.id };
          },
          suggest: async (args) => {
            const parsed = z
              .object({ every: z.enum(["off", "weekly", "monthly"]) })
              .safeParse(args);
            if (!parsed.success) throw new PluginError("Choose off, weekly or monthly.");
            const { every } = parsed.data;
            const schedules = d.schedules();
            const s = suggestions();
            if (every === "off") {
              if (s) schedules.delete(s.id);
              setSetting(db, SUGGEST_KEY, "");
              return { every };
            }
            const cron = SUGGEST_CRON[every];
            const name = "Suggest an improvement to its code";
            const now = s
              ? schedules.update(s.id, { cron, enabled: true })
              : schedules.create({ name, prompt: SUGGEST_PROMPT, cron }, "owner");
            if (now) setSetting(db, SUGGEST_KEY, `${now.id} ${now.createdAt}`);
            return { every, cron, id: now?.id };
          },
        },
      });
    },
  });
