// Kept in a file of their own, mode 600, not in the database, so the nightly snapshots and the
// settings every client is sent don't carry them. Unset, the host's apply (/etc/hatbot).
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ConnectionSource, Connections } from "@hatbot/shared";

export type NtfyConfig = { url: string; topic: string; token: string };
type Values = Record<string, string>;
type Stored = {
  ntfy?: NtfyConfig;
  env?: Values;
  /** Secrets a plugin takes by any name (MCP's ${NAME}), by plugin. */
  named?: Record<string, Values>;
  /** A plugin's own, by plugin, then by its key. */
  kept?: Record<string, Record<string, Values>>;
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

function read(path: string): Stored {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const s = JSON.parse(text) as Stored & { anthropicApiKey?: unknown; boxes?: unknown };
    const env = values(s.env);
    // Set in Settings before providers were plugins: now the Anthropic plugin's.
    if (typeof s.anthropicApiKey === "string") env.ANTHROPIC_API_KEY ??= s.anthropicApiKey;
    return {
      ntfy:
        s.ntfy && typeof s.ntfy.url === "string" && typeof s.ntfy.topic === "string"
          ? { url: s.ntfy.url, topic: s.ntfy.topic, token: String(s.ntfy.token ?? "") }
          : undefined,
      env,
      named: byId(s.named),
      kept: {
        ...Object.fromEntries(
          Object.entries(s.kept && typeof s.kept === "object" ? s.kept : {}).map(([id, x]) => [
            id,
            byId(x),
          ]),
        ),
        // Boxes' secrets, kept before boxes were a plugin.
        ...(s.boxes && !s.kept?.boxes ? { boxes: byId(s.boxes) } : {}),
      },
    };
  } catch (err) {
    console.error(`${path} isn't readable JSON; the host's settings apply`, err);
    return {};
  }
}

export class Secrets {
  private stored: Stored;
  private listeners: (() => void)[] = [];

  constructor(
    readonly path: string,
    private env: Record<string, string | undefined> = process.env,
  ) {
    this.stored = read(path);
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

  pluginEnv(): Values {
    return this.stored.env ?? {};
  }

  named(plugin: string): Values {
    return this.stored.named?.[plugin] ?? {};
  }

  /** Each value replaces what's set here; null forgets it, and the host's applies again. */
  setPluginEnv(changes: Record<string, string | null>) {
    this.save({ ...this.stored, env: merge(this.stored.env, changes) });
  }

  kept(plugin: string, key: string): Values {
    return this.stored.kept?.[plugin]?.[key] ?? {};
  }

  setKept(plugin: string, key: string, changes: Record<string, string | null>) {
    const mine: Record<string, Values> = { ...this.stored.kept?.[plugin] };
    mine[key] = merge(mine[key], changes);
    if (!Object.keys(mine[key]).length) delete mine[key];
    this.save({ ...this.stored, kept: { ...this.stored.kept, [plugin]: mine } });
  }

  setNamed(plugin: string, changes: Record<string, string | null>) {
    this.save({
      ...this.stored,
      named: { ...this.stored.named, [plugin]: merge(this.stored.named?.[plugin], changes) },
    });
  }

  /** Everything kept for `plugin`, and these values set in Settings. */
  forgetPlugin(plugin: string, env: string[]) {
    const { [plugin]: _named, ...named } = this.stored.named ?? {};
    const { [plugin]: _kept, ...kept } = this.stored.kept ?? {};
    const left = { ...this.stored.env };
    for (const name of env) delete left[name];
    this.save({ ...this.stored, named, kept, env: left });
  }

  /** Never the token. */
  view(): Connections {
    const ntfy = this.ntfy();
    const from = (app: unknown, set: boolean): ConnectionSource =>
      app !== undefined ? "app" : set ? "host" : null;
    return {
      ntfy: {
        url: ntfy.url,
        topic: ntfy.topic,
        tokenSet: Boolean(ntfy.token),
        from: from(this.stored.ntfy, Boolean(ntfy.url)),
      },
    };
  }

  /** A token left out stays as it is now, the host's included. */
  setNtfy(n: { url: string; topic: string; token?: string } | null) {
    this.save({
      ...this.stored,
      ntfy: n ? { url: n.url, topic: n.topic, token: n.token ?? this.ntfy().token } : undefined,
    });
  }

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
