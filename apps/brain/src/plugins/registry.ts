import { join } from "node:path";
import {
  allow,
  askCareful,
  type CallContext,
  covered,
  type Plugin,
  PluginError,
  type PluginFiles,
  type PluginInstance,
  type PluginSignal,
  type PluginTick,
  type PluginTool,
  type PromptPlace,
  SDK_VERSION,
  type ToolImage,
  textOf,
  type Verdict,
} from "@hatbot/plugin-sdk";
import type { PluginEnvInfo, PluginInfo, PluginState, SafetySettings } from "@hatbot/shared";
import { z } from "zod";
import { untrustedBlock } from "../agent/untrusted";
import type { Db } from "../db";
import type { EventBus } from "../events";
import type { Secrets } from "../secrets";
import { deleteSetting, getSetting, setSetting } from "../settings";

const MAX_OUTPUT_CHARS = 30_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];

type Slot = {
  plugin: Plugin;
  enabled: boolean;
  config: unknown;
  state: PluginState;
  message: string | null;
  instance: PluginInstance | null;
  /** Bumped on every (re)start, so a slow start that was overtaken is thrown away. */
  generation: number;
  retries: number;
  retry: ReturnType<typeof setTimeout> | null;
  timers: ReturnType<typeof setInterval>[];
};

export type PluginsDeps = {
  db: Db;
  events: EventBus;
  env?: Record<string, string | undefined>;
  secrets: Secrets;
  files?: PluginFiles;
  dataDir: string;
  reserved: string[];
};

export class Plugins {
  private slots = new Map<string, Slot>();
  private hostEnv: Record<string, string | undefined>;
  /** Which plugin provides each service. */
  private providers = new Map<string, string>();
  private timing = false;
  private stopping = false;
  retryMs = RETRY_MS;

  constructor(
    plugins: Plugin[],
    private d: PluginsDeps,
  ) {
    this.hostEnv = d.env ?? process.env;
    const paths = new Map<string, string>();
    for (const plugin of plugins) {
      if (!/^[a-z][a-z0-9]{1,20}$/.test(plugin.id)) throw new Error(`bad plugin id "${plugin.id}"`);
      if (this.slots.has(plugin.id)) throw new Error(`two plugins named "${plugin.id}"`);
      for (const name of plugin.provides ?? []) {
        const other = this.providers.get(name);
        if (other) throw new Error(`plugins ${other} and ${plugin.id} both provide "${name}"`);
        this.providers.set(name, plugin.id);
      }
      for (const path of [...(plugin.routes ?? []), ...(plugin.publicRoutes ?? [])]) {
        const other = paths.get(path);
        if (other) throw new Error(`plugins ${other} and ${plugin.id} both answer ${path}`);
        paths.set(path, plugin.id);
      }
      migrate(d.db, plugin);
      const stored = this.load(plugin);
      this.slots.set(plugin.id, {
        plugin,
        enabled: stored.enabled,
        config: stored.config,
        state: "off",
        message: null,
        instance: null,
        generation: 0,
        retries: 0,
        retry: null,
        timers: [],
      });
    }
  }

  /** Providers first, so what needs them finds them started. */
  async startAll() {
    this.stopping = false;
    const todo = [...this.slots.values()].filter((s) => s.enabled);
    const started = new Set<string>();
    while (todo.length) {
      const now = todo.filter((s) =>
        (s.plugin.needs ?? []).every((n) => {
          const by = this.providers.get(n);
          return !by || started.has(by) || !todo.some((t) => t.plugin.id === by);
        }),
      );
      // A loop of needs: start them anyway, and each says what it's missing.
      const batch = now.length ? now : todo.slice();
      await Promise.all(batch.map((s) => this.restart(s, false)));
      for (const s of batch) {
        started.add(s.plugin.id);
        todo.splice(todo.indexOf(s), 1);
      }
    }
  }

  async stopAll() {
    this.stopping = true;
    this.timing = false;
    await Promise.all([...this.slots.values()].map((s) => this.stop(s)));
  }

  /** Runs plugins' ticks from now on, as they start; tests call `tick` instead. */
  startTimers() {
    this.timing = true;
    for (const s of this.slots.values()) this.time(s);
  }

  /** Runs a ready plugin's tick once. */
  async tick(id: string, name: string): Promise<void> {
    const t = this.slots.get(id)?.instance?.ticks?.find((x) => x.name === name);
    if (!t || this.slots.get(id)?.state !== "ready") throw new Error(`no tick ${id}:${name}`);
    await t.run();
  }

  /** What a ready plugin gives others; null while none does. */
  service<T>(name: string): T | null {
    const by = this.providers.get(name);
    const s = by ? this.slots.get(by) : undefined;
    return s?.state === "ready" ? ((s.instance?.services?.[name] as T | undefined) ?? null) : null;
  }

  /** The plugins with routes, for the app to send requests on to. */
  routed(): { id: string; routes: string[]; publicRoutes: string[] }[] {
    return [...this.slots.values()]
      .filter((s) => s.plugin.routes?.length || s.plugin.publicRoutes?.length)
      .map((s) => ({
        id: s.plugin.id,
        routes: s.plugin.routes ?? [],
        publicRoutes: s.plugin.publicRoutes ?? [],
      }));
  }

  routesOf(id: string) {
    const s = this.slots.get(id);
    return s?.state === "ready" ? (s.instance?.routes ?? null) : null;
  }

  /** Ready plugins' lines for the prompt at `place`, in a stable order. */
  prompt(place: PromptPlace, only: string[] | null = null, except: string[] = []): string {
    return this.readyOnes(only, except)
      .flatMap((s) => s.instance?.prompt?.[place]?.trim() || [])
      .join("\n");
  }

  list(): PluginInfo[] {
    return [...this.slots.values()].filter((s) => !s.plugin.internal).map((s) => this.info(s));
  }

  get(id: string): PluginInfo | null {
    const s = this.slots.get(id);
    return s && !s.plugin.internal ? this.info(s) : null;
  }

  async update(id: string, patch: { enabled?: boolean; config?: unknown }): Promise<PluginInfo> {
    const s = this.slots.get(id);
    if (!s || s.plugin.internal) throw new PluginError(`No plugin "${id}".`);
    if (patch.config !== undefined) {
      const parsed = s.plugin.config.safeParse(patch.config);
      if (!parsed.success) throw new PluginError(z.prettifyError(parsed.error));
      s.config = parsed.data;
    }
    if (patch.enabled !== undefined) s.enabled = patch.enabled;
    s.retries = 0;
    setSetting(this.d.db, `plugin:${id}`, JSON.stringify({ enabled: s.enabled, config: s.config }));
    if (s.enabled) await this.restart(s);
    else await this.stop(s);
    return this.info(s);
  }

  env(): Record<string, string | undefined> {
    return { ...this.hostEnv, ...this.d.secrets.pluginEnv() };
  }

  /** null goes back to the host's value. Every plugin that reads one restarts with it. */
  async setSecrets(id: string, values: Record<string, string | null>): Promise<PluginInfo> {
    const s = this.slots.get(id);
    if (!s) throw new PluginError(`No plugin "${id}".`);
    const names = Object.keys(values);
    if (s.plugin.named) {
      this.d.secrets.setNamed(id, values);
      s.retries = 0;
      if (s.enabled) await this.restart(s);
      else this.emit(s);
      return this.info(s);
    }
    const own = new Set((s.plugin.env ?? []).map((v) => v.name));
    const other = names.filter((n) => !own.has(n));
    if (other.length) throw new PluginError(`${s.plugin.name} doesn't read ${other.join(", ")}.`);
    this.d.secrets.setPluginEnv(values);
    const readers = [...this.slots.values()].filter((r) =>
      r.plugin.env?.some((v) => names.includes(v.name)),
    );
    await Promise.all(
      readers.map(async (r) => {
        r.retries = 0;
        if (r.enabled) await this.restart(r);
        else this.emit(r);
      }),
    );
    return this.info(s);
  }

  async test(id: string): Promise<string> {
    const s = this.slots.get(id);
    if (!s) throw new PluginError(`No plugin "${id}".`);
    const { instance, generation } = s;
    if (s.state !== "ready" || !instance) throw new PluginError(`${s.plugin.name} isn't ready.`);
    if (!instance.test) throw new PluginError(`${s.plugin.name} has no test.`);
    try {
      return await instance.test();
    } finally {
      // A test can change what it offers (PBS checks its token again), as recovering can.
      if (generation === s.generation && !(await this.recheck(s, instance, "after its test")))
        this.later(s);
    }
  }

  async signals(): Promise<PluginSignal[]> {
    const found = await Promise.all(
      [...this.slots.values()]
        .filter((s) => s.enabled && s.state === "ready" && s.instance?.signals)
        .map(async (s) => {
          try {
            const list = await Promise.race([
              s.instance?.signals?.() ?? Promise.resolve([]),
              Bun.sleep(30_000).then(() => {
                throw new PluginError("it didn't answer in 30 seconds");
              }),
            ]);
            return list.map((x) => ({ key: `${s.plugin.id}:${x.key}`, text: x.text }));
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            return [
              {
                key: `${s.plugin.id}:unreachable`,
                text: `${s.plugin.name} couldn't be checked: ${why}`,
              },
            ];
          }
        }),
    );
    return found.flat();
  }

  async action(id: string, name: string, args: unknown): Promise<unknown> {
    const s = this.slots.get(id);
    const actions = s?.instance?.actions;
    // Its own actions only: not what every object has, such as "constructor".
    const fn = actions && Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (!s || !fn) throw new PluginError(`${s?.plugin.name ?? id} can't do "${name}" right now.`);
    return fn(args);
  }

  /** A stable order: it's part of the prompt cache. */
  private readyOnes(only: string[] | null, except: string[], ready = true) {
    return [...this.slots.values()]
      .filter(
        (s) =>
          (ready ? s.state === "ready" : s.enabled) &&
          (everyBot(s.plugin) ||
            ((!only || only.includes(s.plugin.id)) && !except.includes(s.plugin.id))),
      )
      .sort((a, b) => a.plugin.id.localeCompare(b.plugin.id));
  }

  readyFor(id: string, only: string[] | null = null, except: string[] = []): boolean {
    return this.readyOnes(only, except).some((s) => s.plugin.id === id);
  }

  /** Running or not, so a restart doesn't change the other bots' prompts. */
  names(only: string[] | null = null, except: string[] = []): string[] {
    return this.readyOnes(only, except, false)
      .filter((s) => !everyBot(s.plugin))
      .map((s) => s.plugin.name);
  }

  /** What the model may be offered. */
  tools(only: string[] | null = null, except: string[] = []): PluginTool[] {
    return this.brainTools(only, except).filter((t) => !t.brainOnly);
  }

  /** With the ones only the brain calls. */
  brainTools(only: string[] | null = null, except: string[] = []): PluginTool[] {
    return this.readyOnes(only, except).flatMap((s) => s.instance?.tools ?? []);
  }

  guidance(only: string[] | null = null, except: string[] = []): string {
    return this.readyOnes(only, except)
      .flatMap((s) =>
        s.instance?.guidance ? `${s.plugin.name}\n${s.instance.guidance.trim()}` : [],
      )
      .join("\n\n");
  }

  pluginOf(toolName: string): Plugin | null {
    return this.slots.get(toolName.split("_")[0] ?? "")?.plugin ?? null;
  }

  private load(plugin: Plugin): { enabled: boolean; config: unknown } {
    const stored = saved(this.d.db, plugin.id);
    const config = plugin.config.safeParse(stored.config ?? {});
    if (!config.success) {
      console.error(`plugin ${plugin.id}: stored settings are invalid; using defaults`);
    }
    return {
      enabled: plugin.internal || (stored.enabled ?? plugin.defaultOn ?? false),
      config: config.success ? config.data : plugin.config.parse({}),
    };
  }

  /** `cascade`: what needs its services starts again too. */
  private async restart(s: Slot, cascade = true) {
    await this.stop(s, false);
    const generation = ++s.generation;
    s.state = "starting";
    s.message = null;
    this.emit(s);
    let instance: PluginInstance | null = null;
    let state: PluginState;
    let message: string | null = null;
    try {
      if ((s.plugin.sdk ?? SDK_VERSION) !== SDK_VERSION)
        throw new PluginError(
          `It's made for another version of Hatbot's plugin API (${s.plugin.sdk}, not ${SDK_VERSION}).`,
        );
      const missing = this.missing(s.plugin);
      instance = missing
        ? { status: { state: "needs_setup", message: missing }, tools: [] }
        : await s.plugin.start({
            config: s.config,
            env: this.env(),
            named: s.plugin.named ? this.d.secrets.named(s.plugin.id) : {},
            db: this.d.db,
            files: this.d.files,
            dataDir: join(this.d.dataDir, "plugins", s.plugin.id),
            service: <T>(name: string) => {
              if (!s.plugin.needs?.includes(name))
                throw new Error(`plugin ${s.plugin.id} doesn't say it needs "${name}"`);
              return this.service<T>(name) as T;
            },
            store: {
              get: (key) => getSetting(this.d.db, `${s.plugin.id}:${key}`),
              set: (key, value) => {
                if (value === null) deleteSetting(this.d.db, `${s.plugin.id}:${key}`);
                else setSetting(this.d.db, `${s.plugin.id}:${key}`, value);
              },
            },
            saveSecrets: async (values) => {
              await this.setSecrets(s.plugin.id, values);
            },
          });
      this.checkTools(s.plugin, instance.tools);
      state = instance.status.state;
      if (instance.status.state !== "ready") message = instance.status.message;
    } catch (err) {
      state = "error";
      message =
        err instanceof PluginError ? err.message : "It failed to start; see the brain's log.";
      if (!(err instanceof PluginError))
        console.error(`plugin ${s.plugin.id} failed to start`, err);
    }
    if (generation !== s.generation) {
      await instance?.stop?.();
      return;
    }
    s.instance = instance;
    s.state = state;
    s.message = message;
    this.emit(s);
    this.later(s);
    this.time(s);
    if (cascade) await this.dependents(s);
  }

  /** What it needs that no ready plugin provides, in words; null when nothing. */
  private missing(plugin: Plugin): string | null {
    const names = (plugin.needs ?? []).filter((n) => this.service(n) === null);
    if (!names.length) return null;
    const by = [
      ...new Set(
        names.map((n) => {
          const id = this.providers.get(n);
          const p = id ? this.slots.get(id)?.plugin : undefined;
          return p ? `the ${p.name} plugin` : `a plugin that provides "${n}"`;
        }),
      ),
    ];
    return `It needs ${by.join(" and ")}, switched on and working.`;
  }

  /** Starts again what needs `s`'s services, so each gets them as they are now. */
  private async dependents(s: Slot) {
    if (this.stopping) return;
    const gives = s.plugin.provides ?? [];
    if (!gives.length) return;
    const users = [...this.slots.values()].filter(
      (x) => x.enabled && x.plugin.needs?.some((n) => gives.includes(n)),
    );
    await Promise.all(users.map((x) => this.restart(x)));
  }

  private time(s: Slot) {
    for (const t of s.timers) clearInterval(t);
    s.timers = [];
    if (!this.timing || s.state !== "ready") return;
    const id = s.plugin.id;
    s.timers = (s.instance?.ticks ?? []).map((t: PluginTick) => {
      const timer = setInterval(() => {
        try {
          const out = t.run();
          if (out instanceof Promise)
            out.catch((err) => console.error(`${id} ${t.name} failed`, err));
        } catch (err) {
          console.error(`${id} ${t.name} failed`, err);
        }
      }, t.everyMs);
      timer.unref?.();
      return timer;
    });
  }

  private later(s: Slot) {
    if (s.retry) clearTimeout(s.retry);
    s.retry = null;
    const down = s.state === "error" || (s.state === "ready" && s.instance?.down?.());
    if (!s.enabled || !down) {
      s.retries = 0;
      return;
    }
    const ms = this.retryMs[Math.min(s.retries, this.retryMs.length - 1)] ?? 15 * 60_000;
    s.retries++;
    const generation = s.generation;
    s.retry = setTimeout(() => {
      s.retry = null;
      if (generation === s.generation) void this.again(s);
    }, ms);
    s.retry.unref?.();
  }

  private async again(s: Slot) {
    const instance = s.instance;
    if (s.state === "ready" && instance?.recover) {
      const generation = s.generation;
      await instance.recover().catch((err) => console.error(`plugin ${s.plugin.id}: recover`, err));
      if (generation !== s.generation) return;
      await this.recheck(s, instance, "after recovering");
      this.later(s);
      return;
    }
    console.log(`plugin ${s.plugin.id}: starting again (try ${s.retries})`);
    await this.restart(s);
  }

  /** A bad tool would fail every request. */
  private async recheck(s: Slot, instance: PluginInstance, after: string): Promise<boolean> {
    try {
      this.checkTools(s.plugin, instance.tools);
      this.emit(s);
      return true;
    } catch (err) {
      console.error(`plugin ${s.plugin.id}: ${after}`, err);
      await this.stop(s);
      s.state = "error";
      s.message = "Its tools changed into ones Hatbot can't offer; see the brain's log.";
      this.emit(s);
      return false;
    }
  }

  private async stop(s: Slot, cascade = true) {
    s.generation++;
    if (s.retry) clearTimeout(s.retry);
    s.retry = null;
    for (const t of s.timers) clearInterval(t);
    s.timers = [];
    const instance = s.instance;
    s.instance = null;
    const was = s.state;
    s.state = "off";
    s.message = null;
    if (was !== "off") this.emit(s);
    try {
      await instance?.stop?.();
    } catch (err) {
      console.error(`plugin ${s.plugin.id} failed to stop`, err);
    }
    if (cascade && was !== "off") await this.dependents(s);
  }

  private checkTools(plugin: Plugin, tools: PluginTool[]) {
    const seen = new Set<string>();
    for (const t of tools) {
      if ((!plugin.internal && !t.name.startsWith(`${plugin.id}_`)) || !TOOL_NAME.test(t.name))
        throw new Error(`plugin ${plugin.id}: tool "${t.name}" must be named ${plugin.id}_…`);
      if (seen.has(t.name) || this.d.reserved.includes(t.name))
        throw new Error(`plugin ${plugin.id}: tool name "${t.name}" is taken`);
      if (t.access === "read" && t.policy)
        throw new Error(`plugin ${plugin.id}: read tool "${t.name}" can't have a policy`);
      seen.add(t.name);
    }
  }

  private info(s: Slot): PluginInfo {
    return {
      id: s.plugin.id,
      name: s.plugin.name,
      description: s.plugin.description,
      enabled: s.enabled,
      state: s.state,
      message: s.message ?? (s.state === "ready" ? (s.instance?.down?.() ?? null) : null),
      env: (s.plugin.env ?? []).map((v) => this.envInfo(v)),
      named: s.plugin.named ? Object.keys(this.d.secrets.named(s.plugin.id)).sort() : null,
      config: s.config,
      tools: (s.instance?.tools ?? []).map((t) => ({
        name: t.name,
        access: t.access,
        description: t.description,
      })),
      testable: Boolean(s.instance?.test),
    };
  }

  private envInfo(v: NonNullable<Plugin["env"]>[number]): PluginEnvInfo {
    const app = this.d.secrets.pluginEnv()[v.name];
    const value = app ?? this.hostEnv[v.name] ?? "";
    return {
      name: v.name,
      secret: Boolean(v.secret),
      optional: Boolean(v.optional),
      hint: v.hint ?? null,
      set: Boolean(value),
      from: app !== undefined ? "app" : value ? "host" : null,
      value: v.secret || !value ? null : value,
    };
  }

  private emit(s: Slot) {
    this.d.events.emit({ type: "plugin.updated", plugin: this.info(s) });
  }
}

export function saved(db: Db, id: string): { enabled?: boolean; config?: unknown } {
  const row = getSetting(db, `plugin:${id}`);
  return row === null ? {} : JSON.parse(row);
}

export const untrustedOf = (t: PluginTool, input: unknown, output?: string): boolean =>
  typeof t.untrusted === "function" ? t.untrusted(input, output) : Boolean(t.untrusted);

/** Labels untrusted output so it can't pose as instructions. Policy is the caller's job. */
export async function runPluginTool(
  t: PluginTool,
  input: unknown,
  call: CallContext,
): Promise<{
  content: string;
  isError: boolean;
  untrusted: boolean;
  text: string;
  images?: ToolImage[];
}> {
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) {
    const content = `Invalid input: ${z.prettifyError(parsed.error)}`;
    return { content, isError: true, untrusted: false, text: content };
  }
  const label = (text: string, untrusted: boolean) =>
    untrusted ? untrustedBlock("tool_output", text, { tool: t.name }) : text;
  let out: string;
  let images: ToolImage[] | undefined;
  try {
    const r = await t.run(parsed.data, call);
    out = textOf(r);
    if (typeof r !== "string" && r.images.length) images = r.images;
  } catch (err) {
    if (call.signal.aborted) throw err;
    // An untrusted source's error message is untrusted too.
    if (err instanceof PluginError) {
      const untrusted = untrustedOf(t, parsed.data);
      return {
        content: label(err.message, untrusted),
        isError: true,
        untrusted,
        text: err.message,
      };
    }
    console.error(`tool ${t.name} failed`, err);
    const content = "The tool failed with an internal error.";
    return { content, isError: true, untrusted: false, text: content };
  }
  const untrusted = untrustedOf(t, parsed.data, out);
  if (out.length > MAX_OUTPUT_CHARS)
    out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n… (cut; ${out.length} characters in all)`;
  return { content: label(out, untrusted), isError: false, untrusted, text: out, images };
}

export function untrustedDefinitions(tools: PluginTool[]): string | null {
  const servers = new Set(
    tools.filter((t) => t.untrustedDefinition).map((t) => t.name.split("_")[1]),
  );
  return servers.size
    ? `Tool descriptions from untrusted MCP servers, not accepted in Settings (${[...servers].join(", ")})`
    : null;
}

export function describeCall(t: PluginTool, input: unknown): string {
  const parsed = t.schema.safeParse(input);
  if (parsed.success && t.describe) return t.describe(parsed.data);
  return `${t.name} ${JSON.stringify(input ?? {})}`;
}

/**
 * Once a task or conversation has read untrusted content, every write needs approval, unless Haiku's
 * review lets it through or the tool's policy says an approval you gave covers it. `safety` is what
 * Settings → Safety asks for: a tool you always or never want asked about, and the untrusted rule.
 */
export function verdictFor(
  t: PluginTool,
  input: unknown,
  call: CallContext,
  tainted = call.task?.tainted ?? false,
  safety?: Pick<SafetySettings, "tools" | "untrusted">,
): Verdict {
  if (t.access === "read") return allow();
  const parsed = t.schema.safeParse(input);
  // Bad input fails in runPluginTool, before anything runs.
  if (!parsed.success) return allow();
  const own = t.policy ? t.policy(parsed.data, call) : allow();
  if (own.action === "block") return own;
  const mine = safety?.tools[t.name];
  if (mine === "ask")
    return own.action === "ask"
      ? { ...own, always: true, careful: true }
      : askCareful(`You asked to be asked before ${t.name} runs.`, t.kind);
  if (own.action === "ask" && own.careful) return own;
  if (mine === "allow") return covered("You let it run without asking in Settings.");
  const untrustedAsks = safety?.untrusted ?? true;
  if (own.action === "ask" && own.tainted && !untrustedAsks) return allow();
  if (own.action !== "allow" || own.covered) return own;
  if (tainted && untrustedAsks)
    return {
      action: "ask",
      why: `This ${call.task ? "task" : "conversation"} has read untrusted content, so changes need your approval.`,
      tainted: true,
      ...(t.kind ? { kind: t.kind } : {}),
    };
  return own;
}

/** Internal plugins and ones every bot gets aren't limited by a bot's list. */
const everyBot = (p: Plugin) => Boolean(p.internal || p.allBots);

/** A plugin's own tables, apart from the core's: its migrations run once each, in order. */
function migrate(db: Db, plugin: Plugin) {
  const list = plugin.migrations ?? [];
  if (!list.length) return;
  const done =
    db
      .query<{ v: number | null }, [string]>(
        "SELECT max(version) AS v FROM plugin_migrations WHERE plugin = ?",
      )
      .get(plugin.id)?.v ?? 0;
  for (let v = done + 1; v <= list.length; v++)
    db.transaction(() => {
      db.exec(list[v - 1] as string);
      db.query("INSERT INTO plugin_migrations (plugin, version) VALUES (?, ?)").run(plugin.id, v);
    })();
}
