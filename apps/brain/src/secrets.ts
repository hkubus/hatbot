// The Anthropic API key and the ntfy server, as set in Settings (PLAN.md §6.4). They're kept in a file
// of their own in the data directory, mode 600, not in the database: the nightly snapshots and the
// settings every client is sent don't carry them. Unset, the host's apply (/etc/hatbot, from deploy.sh).
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { ConnectionSource, Connections } from "@hatbot/shared";

export type NtfyConfig = { url: string; topic: string; token: string };
type Stored = { anthropicApiKey?: string; ntfy?: NtfyConfig };

/** Throws, with the API's answer, when the API won't take the key. */
export type KeyCheck = (key: string) => Promise<void>;

/** The cheapest call that needs a working key. */
export const checkApiKey: KeyCheck = async (key) => {
  await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
};

function read(path: string): Stored {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const s = JSON.parse(text) as Stored;
    return {
      anthropicApiKey: typeof s.anthropicApiKey === "string" ? s.anthropicApiKey : undefined,
      ntfy:
        s.ntfy && typeof s.ntfy.url === "string" && typeof s.ntfy.topic === "string"
          ? { url: s.ntfy.url, topic: s.ntfy.topic, token: String(s.ntfy.token ?? "") }
          : undefined,
    };
  } catch (err) {
    console.error(`${path} isn't readable JSON; the host's API key and ntfy apply`, err);
    return {};
  }
}

export class Secrets {
  private stored: Stored;
  private listeners: (() => void)[] = [];

  constructor(
    readonly path: string,
    private env: Record<string, string | undefined> = process.env,
    private checkKey: KeyCheck = checkApiKey,
  ) {
    this.stored = read(path);
  }

  apiKey(): string {
    return this.stored.anthropicApiKey ?? this.env.ANTHROPIC_API_KEY ?? "";
  }

  ntfy(): NtfyConfig {
    return (
      this.stored.ntfy ?? {
        url: (this.env.NTFY_URL ?? "").replace(/\/$/, ""),
        topic: this.env.NTFY_TOPIC ?? "",
        token: this.env.NTFY_TOKEN ?? "",
      }
    );
  }

  /** For the app: whether each is set and where from, never the key or the token. */
  view(): Connections {
    const key = this.apiKey();
    const ntfy = this.ntfy();
    const from = (app: unknown, set: boolean): ConnectionSource =>
      app !== undefined ? "app" : set ? "host" : null;
    return {
      anthropic: {
        set: Boolean(key),
        from: from(this.stored.anthropicApiKey, Boolean(key)),
        ending: key.length >= 20 ? key.slice(-4) : null,
      },
      ntfy: {
        url: ntfy.url,
        topic: ntfy.topic,
        tokenSet: Boolean(ntfy.token),
        from: from(this.stored.ntfy, Boolean(ntfy.url)),
      },
    };
  }

  /** Tries the key first and throws if the API won't take it. Null goes back to the host's. */
  async setApiKey(key: string | null) {
    if (key) await this.checkKey(key);
    this.save({ ...this.stored, anthropicApiKey: key ?? undefined });
  }

  /** A token left out stays as it is now, the host's included. Null goes back to the host's. */
  setNtfy(n: { url: string; topic: string; token?: string } | null) {
    this.save({
      ...this.stored,
      ntfy: n ? { url: n.url, topic: n.topic, token: n.token ?? this.ntfy().token } : undefined,
    });
  }

  /** Called after each change, to point the model client and the notifier at it. */
  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private save(next: Stored) {
    // Written whole and moved into place: a crash halfway leaves the old file, not half of one. The
    // temporary file is new each time, so it's created 600 rather than keeping a looser mode.
    const tmp = `${this.path}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.stored = next;
    for (const fn of this.listeners) fn();
  }
}
