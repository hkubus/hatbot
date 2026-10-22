// A "." or ".." part in a name would step out of the repository's endpoints once the URL is resolved,
// and a branch git wouldn't take could land somewhere else ("main/" on main).
import { join, posix } from "node:path";
import { z } from "zod";
import type { DesktopAgent } from "../desktop/client";
import {
  archive,
  type Checkout,
  checkoutDiff,
  commitAndPush,
  fetchBranch,
  moveBase,
  mustHave,
  putCheckout,
  remoteEnv,
  remoteHead,
  serially,
} from "./checkout";
import { allow, ask, PluginError, type PluginTool, tool } from "./plugin";

const dotParts = (s: string) => s.split("/").some((p) => p === "." || p === "..");

export const Repo = (example: string) =>
  z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name")
    .refine((r) => !dotParts(r), "owner/name")
    .describe(`The repository as owner/name, e.g. "${example}"`);

export const Path = z
  .string()
  .max(500)
  .refine((p) => !dotParts(p), 'a path inside the repository, without "." or ".." parts');

/** git check-ref-format's rules. */
export function validRef(name: string): boolean {
  if (!name || name.length > 200 || name === "@" || name.startsWith("-")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("//") || name.includes("..") || name.includes("@{")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".lock"));
}

export const Ref = z.string().max(200).refine(validRef, "a branch, tag or commit");

export const Branch = z
  .string()
  .max(200)
  .refine(
    (b) => validRef(b) && !b.startsWith("refs/"),
    "a branch name, e.g. main or hatbot/fix-ci",
  );

/** Case doesn't make another branch of main on a forge. */
export const sameBranch = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Files CI runs with the repository's secrets. Git and the forges clean paths before writing, so check
 * them that way.
 */
export function runsInCi(path: string, dirs = ["github"]): boolean {
  const clean = posix.normalize(`/${path}`).toLowerCase();
  const folder = new RegExp(`^/\\.(${dirs.join("|")})/(workflows|actions)/`);
  return folder.test(clean) || /\/action\.ya?ml$/.test(clean);
}

export const Num = z.number().int().positive().describe("The issue or pull request number");

export const repoPath = (repo: string) => {
  const [owner, name] = repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};
export const contentsPath = (repo: string, path: string) =>
  `${repoPath(repo)}/contents/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;

export function forgeTools(
  id: string,
  {
    Repo,
    api,
    merge,
    drafts = false,
  }: {
    Repo: z.ZodType<string>;
    api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    merge: [string, (method: "merge" | "rebase" | "squash") => unknown];
    drafts?: boolean;
  },
): PluginTool[] {
  type Created = { number: number; html_url: string };
  const Pr = z.object({
    repo: Repo,
    head: Branch.describe("The branch with the changes"),
    base: Branch.describe("The branch to merge into, usually the default branch"),
    title: z.string().min(1).max(255),
    body: z.string().max(20_000).default(""),
  });
  return [
    tool({
      name: `${id}_comment`,
      description: "Comment on an issue or pull request, as your bot account. Markdown.",
      access: "write",
      schema: z.object({ repo: Repo, number: Num, body: z.string().min(1).max(20_000) }),
      describe: ({ repo, number }) => `Comment on ${repo}#${number}`,
      run: async ({ repo, number, body }) => {
        const c = await api<Created>("POST", `${repoPath(repo)}/issues/${number}/comments`, {
          body,
        });
        return `Commented: ${c.html_url}`;
      },
    }),
    tool({
      name: `${id}_create_issue`,
      description: "Open an issue, as your bot account.",
      access: "write",
      schema: z.object({
        repo: Repo,
        title: z.string().min(1).max(255),
        body: z.string().max(20_000).default(""),
      }),
      describe: ({ repo, title }) => `Open an issue in ${repo}: ${title}`,
      run: async ({ repo, title, body }) => {
        const i = await api<Created>("POST", `${repoPath(repo)}/issues`, { title, body });
        return `Opened #${i.number}: ${i.html_url}`;
      },
    }),
    tool<z.infer<typeof Pr> & { draft?: boolean }>({
      name: `${id}_open_pr`,
      description: "Open a pull request from head into base, as your bot account.",
      access: "write",
      schema: drafts ? Pr.extend({ draft: z.boolean().optional() }) : Pr,
      describe: ({ repo, head, base }) => `Open a pull request in ${repo}: ${head} into ${base}`,
      run: async ({ repo, draft, ...pr }) => {
        const p = await api<Created>("POST", `${repoPath(repo)}/pulls`, {
          ...pr,
          ...(draft ? { draft } : {}),
        });
        return `Opened pull request #${p.number}: ${p.html_url}`;
      },
    }),
    tool({
      name: `${id}_close`,
      description: "Close an issue or pull request without merging, or reopen one.",
      access: "write",
      schema: z.object({ repo: Repo, number: Num, reopen: z.boolean().optional() }),
      describe: ({ repo, number, reopen }) => `${reopen ? "Reopen" : "Close"} ${repo}#${number}`,
      run: async ({ repo, number, reopen }) => {
        await api("PATCH", `${repoPath(repo)}/issues/${number}`, {
          state: reopen ? "open" : "closed",
        });
        return `${reopen ? "Reopened" : "Closed"} ${repo}#${number}.`;
      },
    }),
    tool({
      name: `${id}_merge`,
      description: "Merge a pull request. It needs approval (the safety review or the owner).",
      access: "write",
      schema: z.object({
        repo: Repo,
        number: Num,
        method: z.enum(["merge", "rebase", "squash"]).default("merge"),
      }),
      describe: ({ repo, number, method }) => `Merge ${repo}#${number} (${method})`,
      policy: () => ask("Merging changes the target branch for everyone."),
      run: async ({ repo, number, method }) => {
        await api(merge[0], `${repoPath(repo)}/pulls/${number}/merge`, merge[1](method));
        return `Merged ${repo}#${number}.`;
      },
    }),
  ];
}

const LISTED = 50;

/** The brain fetches and pushes; the sandbox never gets the token. */
export function checkoutTools(
  id: string,
  d: {
    Repo: z.ZodType<string>;
    api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
    desktop: DesktopAgent;
    dir: string;
    gitBase: string;
    auth: () => Promise<string>;
    who: () => Promise<{ name: string; email: string }>;
    /** For policy; checking out a repository adds its own. */
    defaults: Map<string, string>;
    ci: string[];
  },
): PluginTool[] {
  const place = (repo: string): Checkout => {
    const [owner, name] = repo.split("/") as [string, string];
    return {
      cache: join(d.dir, "repos", owner.toLowerCase(), `${name.toLowerCase()}.git`),
      url: `${d.gitBase}/${owner}/${name}.git`,
      remote: async () => remoteEnv(await d.auth()),
      work: `repos/${id}/${owner}/${name}`,
      scratch: `repos/.hatbot/${id}/${owner}/${name}`,
      tool: `${id}_checkout`,
    };
  };
  const defaultBranch = async (repo: string) => {
    const { default_branch } = await d.api<{ default_branch: string }>("GET", repoPath(repo));
    if (!validRef(default_branch))
      throw new PluginError(`${repo} names an odd default branch: ${default_branch}`);
    d.defaults.set(repo, default_branch);
    return default_branch;
  };
  // One task at a time changes the bare clones.
  const serial = serially();
  const sandbox = (signal: AbortSignal) => d.desktop.withSignal?.(signal) ?? d.desktop;

  return [
    tool({
      name: `${id}_checkout`,
      description: `Put a repository's files in the sandbox at ~/repos/${id}/<owner>/<name>, in place of any checkout there, as a git repository: a branch as it is now, the default branch if left out. Change them there with code_run, or claude_code for bigger changes, then ${id}_push sends what changed to a branch. The brain fetches and pushes; the sandbox never gets the token.`,
      access: "write",
      label: "Checking out code",
      schema: z.object({
        repo: d.Repo,
        branch: Branch.optional().describe(
          "The branch to check out; the default branch if left out",
        ),
      }),
      // A repository's files are written by others, and the sandbox reaches the internet.
      untrusted: true,
      describe: ({ repo, branch }) =>
        `Check out ${repo}${branch ? `@${branch}` : ""} in the sandbox`,
      run: async ({ repo, branch }, call) => {
        const c = place(repo);
        const at = branch ?? (await defaultBranch(repo));
        const { sha, tar } = await serial(async () => {
          const sha = await fetchBranch(c, at);
          return { sha, tar: await archive(c, sha) };
        });
        const out = await putCheckout(sandbox(call.signal), c, {
          tar,
          sha,
          branch: at,
          before: [`if [ -e ${c.work} ]; then echo "It replaced the earlier checkout there."; fi`],
          after: [
            `echo "$(git ls-files | wc -l) files. At the top:"`,
            "ls -Ap | grep -vx '\\.git/' || true",
          ],
          timeoutS: 600,
        });
        return `${repo} at ${at} (${sha.slice(0, 10)}) is in ~/${c.work}.\n${out}\nChange it there with code_run, or claude_code for bigger changes, then ${id}_push sends what changed to a branch.`;
      },
    }),
    tool({
      name: `${id}_push`,
      description: `Push what changed in a checkout from ${id}_checkout to a branch, as one commit by your bot account on the commit checked out: to a new branch, or to the branch checked out if it hasn't moved since. Never forced. It doesn't change CI files: ${id}_commit_files does, with approval. Pushing to the default branch needs approval. After more changes, push again to add to the branch. Then open a pull request with ${id}_open_pr.`,
      access: "write",
      schema: z.object({
        repo: d.Repo,
        branch: Branch.describe(
          'The branch to push to: a new one, e.g. "hatbot/fix-login", or the one checked out',
        ),
        message: z
          .string()
          .min(1)
          .max(20_000)
          .describe("The commit message: a first line saying what changed, then why"),
      }),
      // The names of the files come from the sandbox.
      untrusted: true,
      describe: ({ repo, branch, message }) =>
        `Push to ${repo}@${branch}: ${message.trim().split("\n")[0]}`,
      policy: ({ repo, branch }) => {
        const main = d.defaults.get(repo);
        if (!main) return ask(`It pushes to ${branch}, and ${repo}'s default branch isn't known.`);
        if (sameBranch(branch, main))
          return ask(`It pushes straight to ${branch}, the default branch.`);
        return allow();
      },
      run: async ({ repo, branch, message }, call) => {
        const c = place(repo);
        const shell = sandbox(call.signal);
        const { patch, from, branch: was } = await checkoutDiff(shell, c);
        let added = false;
        const pushed = await serial(async () =>
          commitAndPush(c, {
            from,
            patch,
            message,
            branch,
            who: await d.who(),
            verb: "pushed",
            prepare: async () => {
              await mustHave(c, from);
              const head = await remoteHead(c, branch);
              // Fast-forward only: what someone else pushed since isn't undone.
              if (head && head !== from)
                throw new PluginError(
                  `${branch} is at ${head.slice(0, 10)}, not at the commit checked out (${from.slice(0, 10)}${was ? ` of ${was}` : ""}): it has moved since the checkout, or it's another branch. Check it out again, or push to a new branch.`,
                );
              added = head === from;
            },
            check: (files) => {
              const ci = files.map((f) => f.path).filter((path) => runsInCi(path, d.ci));
              if (ci.length)
                throw new PluginError(
                  `It changes ${ci.join(", ")}, which CI runs with the repository's secrets. Put them back (git checkout base -- <path>) and push the rest; ${id}_commit_files changes them, with approval.`,
                );
            },
          }),
        );
        const { commit, stat, files } = pushed;
        const lines = [
          `Pushed ${commit.slice(0, 10)} to ${added ? branch : `${branch}, a new branch`}: ${stat}.`,
          ...files.slice(0, LISTED).map((f) => `  ${f.status} ${f.path}`),
          ...(files.length > LISTED ? [`  and ${files.length - LISTED} more`] : []),
        ];
        try {
          await moveBase(shell, c, commit, branch);
          lines.push(`The checkout goes on from it: push again to add to ${branch}.`);
        } catch (err) {
          if (!(err instanceof PluginError)) throw err;
          lines.push(
            `The checkout couldn't move on to it (${err.message}): check out ${branch} before pushing more.`,
          );
        }
        lines.push(`Open a pull request from it with ${id}_open_pr.`);
        return lines.join("\n");
      },
    }),
  ];
}
