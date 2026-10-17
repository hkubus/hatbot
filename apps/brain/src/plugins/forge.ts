// What the GitHub and Forgejo plugins share: names that are safe to put in an API path, and which
// files run in CI. A "." or ".." part would step out of the repository's endpoints once the URL is
// resolved, and a branch git wouldn't take could land somewhere else ("main/" on main).
import { posix } from "node:path";
import { z } from "zod";

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
