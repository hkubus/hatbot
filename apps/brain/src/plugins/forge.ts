// What the GitHub and Forgejo plugins share: names that are safe to put in an API path, which files
// run in CI, and the write tools that work the same on both. A "." or ".." part would step out of the
// repository's endpoints once the URL is resolved, and a branch git wouldn't take could land
// somewhere else ("main/" on main).
import { posix } from "node:path";
import { z } from "zod";
import { ask, type PluginTool, tool } from "./plugin";

const dotParts = (s: string) => s.split("/").some((p) => p === "." || p === "..");

export const Repo = (example: string) =>
  z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name")
    .refine((r) => !dotParts(r), "owner/name")
    .describe(`The repository as owner/name, e.g. "${example}"`);

/** A path in a repository, without "." or ".." parts. */
export const Path = z
  .string()
  .max(500)
  .refine((p) => !dotParts(p), 'a path inside the repository, without "." or ".." parts');

/** Whether git takes this as a ref name (git check-ref-format). */
export function validRef(name: string): boolean {
  if (!name || name.length > 200 || name === "@" || name.startsWith("-")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("//") || name.includes("..") || name.includes("@{")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".lock"));
}

/** A branch, tag or commit. */
export const Ref = z.string().max(200).refine(validRef, "a branch, tag or commit");

/** A branch by its short name, e.g. main or hatbot/fix-ci. */
export const Branch = z
  .string()
  .max(200)
  .refine(
    (b) => validRef(b) && !b.startsWith("refs/"),
    "a branch name, e.g. main or hatbot/fix-ci",
  );

/** Branch names compared the way a forge might: case doesn't make another branch of main. */
export const sameBranch = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Files CI runs with the repository's secrets: workflows, and the actions they use (in the actions
 * folder, or any action.yml). Git and the forges clean paths before writing, so check them that way.
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

/**
 * The write tools both forges have the same way: comment, open an issue or a pull request, close or
 * reopen, and merge. Merging is asked for differently (`merge`: the HTTP method, and the body for a
 * merge method), and only GitHub opens drafts.
 */
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
