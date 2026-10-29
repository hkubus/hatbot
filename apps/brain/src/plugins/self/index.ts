// The brain never runs this code: it keeps a bare clone, applies the sandbox's diff to an index with
// git, which runs nothing, and pushes.
import { join } from "node:path";
import {
  definePlugin,
  httpApi,
  needsSetup,
  PluginError,
  ready,
  type Sandbox,
  SandboxError,
  tool,
} from "@hatbot/plugin-sdk";
import { z } from "zod";
import type { Schedules } from "../../schedules";
import { getSetting, setSetting } from "../../settings";
import {
  archive,
  basicAuth,
  type Checkout,
  checkoutDiff,
  commitAndPush,
  fetchBranch,
  intoCheckout,
  putCheckout,
  remoteEnv,
  serially,
} from "../checkout";
import { Branch, Num, Repo, repoPath, validRef } from "../forge";

const WORK = "hatbot-self/work";
const MAX_CONVERSATION = 30_000;
/** Paths that run as root on the brain, run in CI, or bring in other code: the pull request names them. */
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

1. Call self_checkout. If you don't have it and another bot has the Own code plugin, hand it this whole job with ask_bot, these steps included, and finish with its answer; if none has it, say the Own code plugin is off and finish. self_checkout lists your open pull requests: if one on a ${SUGGESTION} branch is still open, finish and say it's waiting for the owner, without looking further.
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

export const selfPlugin = (d: {
  desktop: Sandbox;
  dir: string;
  /** Made after the plugins. */
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
      const { api } = httpApi("Forgejo", `${base}/api/v1`, {
        authorization: `token ${token}`,
        accept: "application/json",
      });

      let me: { login: string; email: string } | null = null;
      const user = async () => {
        me ??= await api<{ login: string; email: string }>("GET", "/user");
        return me;
      };
      const place: Checkout = {
        cache: join(d.dir, "repo.git"),
        url: env.HATBOT_SELF_GIT_URL ?? `${base}/${repo}.git`,
        remote: async () => remoteEnv(basicAuth((await user()).login, token)),
        work: WORK,
        scratch: "hatbot-self",
        tool: "self_checkout",
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
      const ownPull = async (number: number) => {
        const pr = await api<Pull>("GET", `${repoPath(repo)}/pulls/${number}`);
        if (pr.state !== "open" || pr.merged) throw new PluginError(`#${number} isn't open.`);
        if (!mine(pr, (await user()).login))
          throw new PluginError(
            `#${number} isn't one of your pull requests from a hatbot/ branch of ${repo}, so you can't push to it.`,
          );
        return pr;
      };
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
      // One task at a time changes the bare clone.
      const serial = serially();
      const sandbox = (signal: AbortSignal) => d.desktop.withSignal?.(signal) ?? d.desktop;

      const push = (o: {
        from: string;
        patch: Uint8Array;
        message: string;
        branch: string;
        prepare: () => Promise<void>;
      }) =>
        serial(async () => {
          const { login, email } = await user();
          const who = { name: login, email: email || `${login}@localhost` };
          const pushed = await commitAndPush(place, { ...o, who, verb: "proposed" });
          const careful = pushed.files
            .map((f) => f.path)
            .filter((p) => CAREFUL.some((re) => re.test(p)));
          return { ...pushed, careful };
        });

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

      /** By id and creation time: a deleted schedule's id can come back. */
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
              const sha = await fetchBranch(place, branch);
              return { sha, tar: await archive(place, sha) };
            });
            const output = await putCheckout(sandbox(call.signal), place, {
              tar,
              sha,
              branch,
              after: [
                `echo "${repo}@${branch} ${sha.slice(0, 10)}: $(git ls-files | wc -l) files in ~/${WORK}"`,
                "ls -p",
                "if [ -f bun.lock ]; then bun install --frozen-lockfile 2>&1 | tail -n 3; fi",
              ],
              timeoutS: 600,
            });
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
              const r = await sandbox(call.signal).exec(
                `${intoCheckout(place)}\n${command}`,
                timeout_s,
              );
              const head = r.timedOut ? `Killed after ${timeout_s} s.` : `Exit code ${r.exitCode}`;
              return `${head}\n${r.output}`;
            } catch (err) {
              throw err instanceof SandboxError ? new PluginError(err.message) : err;
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
            const { patch, from } = await checkoutDiff(sandbox(call.signal), place);
            const into = await defaultBranch();
            const pushed = await push({
              from,
              patch,
              message: title,
              branch,
              prepare: async () => {
                await fetchBranch(place, into);
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
            const { patch, from } = await checkoutDiff(sandbox(call.signal), place);
            const pushed = await push({
              from,
              patch,
              message,
              branch,
              prepare: async () => {
                // Fast-forward only: what someone else pushed since isn't undone.
                const head = await fetchBranch(place, branch);
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
