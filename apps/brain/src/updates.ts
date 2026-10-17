// The Update button (PLAN.md §9.4): the brain only asks. hatbot-update runs as root on the brain,
// fetches from git and deploys; this reads what it reports.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateInfo, UpdateStatus } from "@hatbot/shared";
import type { Config } from "./config";

/** A "running" status this old means hatbot-update died without saying so. */
const STALE_MS = 30 * 60_000;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export class Updates {
  constructor(
    private config: Pick<Config, "updateDir" | "updateRequest" | "releaseFile">,
    private clock: () => number = Date.now,
  ) {}

  info(): UpdateInfo {
    const source = readJson<{ url?: string; branch?: string; signed?: boolean }>(
      join(this.config.updateDir, "source.json"),
    );
    return {
      source: source?.url
        ? {
            url: source.url,
            branch: source.branch ?? "main",
            ...(typeof source.signed === "boolean" ? { signed: source.signed } : {}),
          }
        : null,
      current: readJson(this.config.releaseFile),
      status: readJson<UpdateStatus>(join(this.config.updateDir, "status.json")),
      requested: existsSync(this.config.updateRequest),
    };
  }

  running(info = this.info()) {
    const s = info.status;
    const fresh = s?.state === "running" && this.clock() - Date.parse(s.startedAt) < STALE_MS;
    return info.requested || fresh;
  }

  request() {
    writeFileSync(this.config.updateRequest, `${new Date(this.clock()).toISOString()}\n`);
  }
}
