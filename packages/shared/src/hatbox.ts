// What a box's files may be, its box.json, and what the brain and the boxes guest's agent
// (apps/hatbox) say to each other. No zod: the agent ships without it.

export type BoxFile = { path: string; content: string };

export type BoxConfig = {
  /** The hosts its backend may reach, through the agent; nothing else. */
  hosts: string[];
  /** When the brain starts its scheduled(): five-field cron, in the owner's time, at most every 5 minutes. */
  cron?: string;
  /** npm packages, by name, with a version such as "^4.2" or "latest". */
  packages: Record<string, string>;
  /** Names of the secrets its backend reads from its environment, which you set; never their values. */
  secrets: string[];
};

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
/** Secrets a box may declare, and a secret's value, in characters. */
export const MAX_BOX_SECRETS = 5;
export const MAX_BOX_SECRET = 4096;
/** What a backend's scheduled() may tell you, in characters. */
export const MAX_BOX_NOTIFY = 1000;
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Names the runner and Bun read themselves, which a secret mustn't replace. */
const RESERVED_SECRET = /^(HATBOX_|BUN_|NODE_)|^(PATH|HOME|TMPDIR|TZ|LANG)$/;

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

export function badSecretName(name: string): string | null {
  if (!SECRET_NAME.test(name))
    return `"${name}" can't be a secret's name: use capitals, digits and "_", like WEATHER_KEY.`;
  if (RESERVED_SECRET.test(name)) return `${name} is the runner's own; name the secret otherwise.`;
  return null;
}

/** box.json, or what's wrong with it. No box.json reaches nothing and runs no schedule. */
export function boxConfig(text: string | undefined): BoxConfig {
  if (text === undefined) return { hosts: [], packages: {}, secrets: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("box.json isn't valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error('box.json must be an object, like {"hosts": ["shop.example.com"]}.');
  const { hosts = [], cron, packages = {}, secrets = [], ...rest } = raw as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra)
    throw new Error(`box.json has "${extra}"; it takes only hosts, cron, packages and secrets.`);
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
  if (!Array.isArray(secrets) || secrets.length > MAX_BOX_SECRETS)
    throw new Error(`box.json's secrets are up to ${MAX_BOX_SECRETS} names, like ["WEATHER_KEY"].`);
  for (const name of secrets) {
    const bad = typeof name === "string" ? badSecretName(name) : "box.json's secrets are names.";
    if (bad) throw new Error(bad);
  }
  return {
    hosts: [...new Set(names)],
    ...(cron === undefined ? {} : { cron: (cron as string).trim() }),
    packages: Object.fromEntries(entries) as Record<string, string>,
    secrets: [...new Set(secrets as string[])],
  };
}

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

/**
 * POST /boxes/:id/scheduled: how the backend's scheduled() ended. `notify`: what it returned as
 * `{notify: "…"}`, for the brain to tell you.
 */
export type BoxRun = { ok: boolean; error?: string; notify?: string };

/**
 * PUT /boxes/:id/secrets: the values of the secrets the box's backend reads, and the brain's name for
 * this set of them. Every request that may start the backend carries the name (x-hatbox-secrets); one
 * the agent doesn't hold is answered 409 with `secrets`, and the brain sends them again.
 */
export type BoxSecrets = { values: Record<string, string>; digest: string };

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
