// The Anthropic API key, the ntfy server and plugins' tokens, as set in Settings (PLAN.md §6.4), and
// boxes' secrets, set on a box's page (§21.6). They're kept in a file of their own in the data
// directory, mode 600, not in the database: the nightly snapshots and the settings every client is sent
// don't carry them. Unset, the host's apply (/etc/hatbot, from deploy.sh and the env files).
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { ConnectionSource, Connections } from "@hatbot/shared";

export type NtfyConfig = { url: string; topic: string; token: string };
type Values = Record<string, string>;
type Stored = {
  anthropicApiKey?: string;
  ntfy?: NtfyConfig;
  /** Plugins' environment, by name, in place of the host's /etc/hatbot/*.env. */
  env?: Values;
  /** Secrets a plugin takes by any name (MCP's ${NAME}), by plugin. */
  named?: Record<string, Values>;
  /** Boxes' secrets, by box: only its backend reads them. */
  boxes?: Record<string, Values>;
};

/** Only string values, so a hand-edited file can't hand a plugin anything else. */
const values = (v: unknown): Values =>
  Object.fromEntries(
    Object.entries(v && typeof v === "object" ? v : {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );

const byId = (v: unknown): Record<string, Values> =>
  Object.fromEntries(
    Object.entries(v && typeof v === "object" ? v : {}).map(([id, x]) => [id, values(x)]),
  );

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
      env: values(s.env),
      named: byId(s.named),
      boxes: byId(s.boxes),
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

  /** Plugins' environment variables set in Settings, which replace the host's. */
  pluginEnv(): Values {
    return this.stored.env ?? {};
  }

  /** The secrets set in Settings for a plugin that takes them by any name. */
  named(plugin: string): Values {
    return this.stored.named?.[plugin] ?? {};
  }

  /** Each value replaces what's set here; null forgets it, and the host's applies again. */
  setPluginEnv(changes: Record<string, string | null>) {
    this.save({ ...this.stored, env: merge(this.stored.env, changes) });
  }

  /** A box's secrets, by name. */
  box(id: number): Values {
    return this.stored.boxes?.[id] ?? {};
  }

  /** Each value replaces the box's secret by that name; null removes it. */
  setBox(id: number, changes: Record<string, string | null>) {
    const boxes: Record<string, Values> = { ...this.stored.boxes };
    boxes[id] = merge(boxes[id], changes);
    if (!Object.keys(boxes[id]).length) delete boxes[id];
    this.save({ ...this.stored, boxes });
  }

  setNamed(plugin: string, changes: Record<string, string | null>) {
    this.save({
      ...this.stored,
      named: { ...this.stored.named, [plugin]: merge(this.stored.named?.[plugin], changes) },
    });
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

function merge(now: Values | undefined, changes: Record<string, string | null>): Values {
  const out = { ...now };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete out[name];
    else out[name] = value;
  }
  return out;
}
