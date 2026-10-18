// Boxes with files and a backend (PLAN.md §21.6): what a box's files may be, its box.json, and what the
// brain and the boxes guest's agent (apps/hatbox) say to each other. No zod: the agent ships without it.

/** One of a box's files: where it is in the box, and its text. */
export type BoxFile = { path: string; content: string };

/** What a box's box.json says. */
export type BoxConfig = {
  /** The hosts its backend may reach, through the agent; nothing else. */
  hosts: string[];
  /** When the brain starts its scheduled(): five-field cron, in the owner's time, at most every 5 minutes. */
  cron?: string;
  /** npm packages, by name, with a version such as "^4.2" or "latest". */
  packages: Record<string, string>;
};

/** The page, which every box with files has. */
export const BOX_PAGE = "index.html";
/** The backend: `export default { fetch(req), scheduled?() }`. A box with it is a server box. */
export const BOX_SERVER = "server.ts";
export const BOX_CONFIG = "box.json";
export const MAX_BOX_FILES = 50;
/** All of a box's files together, in characters. */
export const MAX_BOX_SOURCE = 2_000_000;
/** A built page or backend, and a body going to or coming from a backend, in bytes. */
export const MAX_BOX_BUILT = 5 * 1024 * 1024;
export const MAX_BOX_BODY = 5 * 1024 * 1024;

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const KINDS = /\.(ts|tsx|js|jsx|mjs|css|html|json|svg|txt|md)$/;
/** What would change how packages are installed or modules found, which only the agent decides. */
const RESERVED = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "tsconfig.json",
  "jsconfig.json",
  "node_modules",
]);
const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// A version or a simple range only: no paths, URLs, git or aliases, which could install from elsewhere.
const RANGE = /^(latest|\*|[\^~]?(\d+|x|\*)(\.(\d+|x|\*)){0,2}(-[0-9A-Za-z.-]+)?)$/;

/** Why `path` can't be one of a box's files, or null if it can. */
export function badPath(path: string): string | null {
  const parts = path.split("/");
  if (path.length > 100 || parts.length > 4 || !parts.every((p) => SEGMENT.test(p)))
    return `"${path}" can't be a box's file: use letters, digits, ".", "-" and "_", in up to 3 folders, nothing starting with a dot.`;
  const reserved = parts.find((p) => RESERVED.has(p.toLowerCase()));
  if (reserved) return `A box can't have ${reserved}: give npm packages in box.json.`;
  if (!KINDS.test(path))
    return `${path}: a box's files are .ts, .tsx, .js, .jsx, .mjs, .css, .html, .json, .svg, .txt or .md.`;
  return null;
}

/** box.json, or what's wrong with it. No box.json reaches nothing and runs no schedule. */
export function boxConfig(text: string | undefined): BoxConfig {
  if (text === undefined) return { hosts: [], packages: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("box.json isn't valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error('box.json must be an object, like {"hosts": ["shop.example.com"]}.');
  const { hosts = [], cron, packages = {}, ...rest } = raw as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra) throw new Error(`box.json has "${extra}"; it takes only hosts, cron and packages.`);
  const names = Array.isArray(hosts)
    ? hosts.map((h) => (typeof h === "string" ? h.toLowerCase() : ""))
    : [];
  if (!Array.isArray(hosts) || names.length > 20 || !names.every((h) => HOST.test(h)))
    throw new Error('box.json\'s hosts are up to 20 host names, like "shop.example.com".');
  if (cron !== undefined && (typeof cron !== "string" || !cron.trim() || cron.length > 100))
    throw new Error('box.json\'s cron is five-field cron, like "0 * * * *".');
  if (!packages || typeof packages !== "object" || Array.isArray(packages))
    throw new Error('box.json\'s packages are names with versions, like {"chart.js": "^4"}.');
  const entries = Object.entries(packages);
  if (entries.length > 20) throw new Error("box.json has more than 20 packages.");
  for (const [name, range] of entries)
    if (name.length > 214 || !PACKAGE.test(name) || typeof range !== "string" || !RANGE.test(range))
      throw new Error(
        `box.json's packages: "${name}" needs an npm name and a version such as "^4.2" or "latest".`,
      );
  return {
    hosts: [...new Set(names)],
    ...(cron === undefined ? {} : { cron: (cron as string).trim() }),
    packages: Object.fromEntries(entries) as Record<string, string>,
  };
}

/** Why these can't be a box's files, or null if they can. */
export function badFiles(files: BoxFile[]): string | null {
  if (!files.length || files.length > MAX_BOX_FILES)
    return `A box has 1 to ${MAX_BOX_FILES} files.`;
  const seen = new Set<string>();
  let size = 0;
  for (const f of files) {
    const bad = badPath(f.path);
    if (bad) return bad;
    if (seen.has(f.path)) return `${f.path} is there twice.`;
    seen.add(f.path);
    size += f.content.length;
  }
  if (size > MAX_BOX_SOURCE) return "A box's files come to at most 2 MB.";
  if (!seen.has(BOX_PAGE)) return "A box needs index.html, its page.";
  try {
    boxConfig(files.find((f) => f.path === BOX_CONFIG)?.content);
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

/** GET /health on the agent. */
export type HatboxStatus = { ok: boolean; version?: string; features?: string[] };

/** GET /boxes: each backend the guest has built, at the version it runs. */
export type GuestBox = { id: number; version: number };

/** POST /boxes/:id/build: the page inlined into one file, and what the build printed. */
export type BoxBuild = { ok: boolean; page?: string; output: string };

/** What hatbox.fetch answers the page, as JSON: a binary body is base64. */
export type BoxResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  base64?: true;
};

/** Headers that belong to one connection, or to how the body travelled, and aren't passed on. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "host",
  "content-length",
  // fetch has already decoded the body.
  "content-encoding",
]);

/** `headers` without what isn't passed on, the agent's own (x-hatbox-…), and `drop`. */
export function passedHeaders(
  headers: Headers | Record<string, string>,
  drop: string[] = [],
): [string, string][] {
  const all = headers instanceof Headers ? [...headers] : Object.entries(headers);
  return all.filter(([k]) => {
    const name = k.toLowerCase();
    return !HOP_HEADERS.has(name) && !drop.includes(name) && !name.startsWith("x-hatbox-");
  });
}
