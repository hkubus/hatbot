import { join } from "node:path";

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  memoryDir: string;
  archiveDir: string;
  /** Built web app to serve on the same origin. */
  webDir: string;
  /** Public origin, e.g. https://hatbot.example.com. Cookie-authenticated writes must come from it. */
  publicUrl: string;
  /** Peers whose X-Forwarded-For is trusted (your reverse proxy). */
  trustedProxies: string[];
  /** hatbot-update's status, written by root (infra/hatbot-update.sh). */
  updateDir: string;
  /** The Update button writes this; hatbot-update.path picks it up. */
  updateRequest: string;
  /** Which commit this copy of the brain is, written by brain-deploy.sh. */
  releaseFile: string;
};

/** A host as it goes in a URL: an IPv6 address in brackets. */
export const urlHost = (host: string) => (host.includes(":") ? `[${host}]` : host);

/**
 * The public address's origin, which is what a browser's Origin header is compared with: lower case,
 * no default port, no trailing slash. A path can't be honoured, so it's refused.
 */
function originOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`HATBOT_PUBLIC_URL isn't an address: ${raw}`);
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      `HATBOT_PUBLIC_URL must be only the scheme and host, like https://hatbot.example.com, not ${raw}`,
    );
  return url.origin;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.HATBOT_DATA_DIR ?? join(import.meta.dir, "../../../data");
  return {
    // Bun takes an IPv6 address without the brackets a URL needs.
    host: (env.HATBOT_HOST ?? "127.0.0.1").replace(/^\[(.*)\]$/, "$1"),
    port: Number(env.HATBOT_PORT ?? 8080),
    dataDir,
    dbPath: env.HATBOT_DB ?? join(dataDir, "hatbot.sqlite"),
    memoryDir: env.HATBOT_MEMORY_DIR ?? join(dataDir, "memory"),
    archiveDir: env.HATBOT_ARCHIVE_DIR ?? join(dataDir, "archive"),
    webDir: env.HATBOT_WEB_DIR ?? join(import.meta.dir, "../../web/dist"),
    publicUrl: originOf(env.HATBOT_PUBLIC_URL ?? "http://localhost:5173"),
    trustedProxies: (env.HATBOT_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    updateDir: env.HATBOT_UPDATE_DIR ?? "/var/lib/hatbot-update",
    updateRequest: env.HATBOT_UPDATE_REQUEST ?? join(dataDir, "update-request"),
    releaseFile: env.HATBOT_RELEASE_FILE ?? join(import.meta.dir, "../../../release.json"),
  };
}
