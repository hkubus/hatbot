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
  /** Public origin, e.g. https://hatbot.gaycats.ovh. Cookie-authenticated writes must come from it. */
  publicUrl: string;
  /** Peers whose X-Forwarded-For is trusted (your reverse proxy). */
  trustedProxies: string[];
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = env.HATBOT_DATA_DIR ?? join(import.meta.dir, "../../../data");
  return {
    host: env.HATBOT_HOST ?? "127.0.0.1",
    port: Number(env.HATBOT_PORT ?? 8080),
    dataDir,
    dbPath: env.HATBOT_DB ?? join(dataDir, "hatbot.sqlite"),
    memoryDir: env.HATBOT_MEMORY_DIR ?? join(dataDir, "memory"),
    archiveDir: env.HATBOT_ARCHIVE_DIR ?? join(dataDir, "archive"),
    webDir: env.HATBOT_WEB_DIR ?? join(import.meta.dir, "../../web/dist"),
    publicUrl: (env.HATBOT_PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    trustedProxies: (env.HATBOT_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
