// Starts the plugins you've switched on, keeps their settings, and hands their tools to the chat and
// to tasks (PLAN.md §4.5).
import type { PluginEnvInfo, PluginInfo, PluginState } from "@hatbot/shared";
import { z } from "zod";
import { untrustedBlock } from "../agent/untrusted";
import type { Db } from "../db";
import type { EventBus } from "../events";
import type { Secrets } from "../secrets";
import { getSetting, setSetting } from "../settings";
import {
  allow,
  type CallContext,
  type Plugin,
  PluginError,
  type PluginFiles,
  type PluginInstance,
  type PluginSignal,
  type PluginTool,
  type Verdict,
} from "./plugin";

/** What a model gets to see of one tool's output. */
const MAX_OUTPUT_CHARS = 30_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** A plugin in error is started again after these, then every last one; a part down, recovered. */
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
  /** Tries since it last worked, for the backoff. */
  retries: number;
  retry: ReturnType<typeof setTimeout> | null;
};

export type PluginsDeps = {
  db: Db;
  events: EventBus;
  /** The host's environment: /etc/hatbot/*.env, as systemd loads them. */
  env?: Record<string, string | undefined>;
  /** What's set in Settings in place of the host's. */
  secrets: Secrets;
  files?: PluginFiles;
  /** The core's own tool names; plugin tools can't take them. */
  reserved: string[];
};

export class Plugins {
  private slots = new Map<string, Slot>();
  private hostEnv: Record<string, string | undefined>;
  /** Waits between tries for a plugin that's down; tests shorten them. */
  retryMs = RETRY_MS;

  constructor(
    plugins: Plugin[],
    private d: PluginsDeps,
  ) {
    this.hostEnv = d.env ?? process.env;
    for (const plugin of plugins) {
      if (!/^[a-z][a-z0-9]{1,20}$/.test(plugin.id)) throw new Error(`bad plugin id "${plugin.id}"`);
      if (this.slots.has(plugin.id)) throw new Error(`two plugins named "${plugin.id}"`);
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
      });
    }
  }

  /** Starts every plugin that's switched on. */
  async startAll() {
    await Promise.all(
      [...this.slots.values()].filter((s) => s.enabled).map((s) => this.restart(s)),
    );
  }

  async stopAll() {
    await Promise.all([...this.slots.values()].map((s) => this.stop(s)));
  }

  list(): PluginInfo[] {
    return [...this.slots.values()].map((s) => this.info(s));
  }

  get(id: string): PluginInfo | null {
    const s = this.slots.get(id);
    return s ? this.info(s) : null;
  }

  /** Switches a plugin on or off, or changes its settings; it restarts with them. */
  async update(id: string, patch: { enabled?: boolean; config?: unknown }): Promise<PluginInfo> {
    const s = this.slots.get(id);
    if (!s) throw new PluginError(`No plugin "${id}".`);
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

  /** The environment plugins start with: the host's, and over it what's set in Settings. */
  env(): Record<string, string | undefined> {
    return { ...this.hostEnv, ...this.d.secrets.pluginEnv() };
  }

  /**
   * Sets a plugin's environment variables, or for one that takes them its secrets by name; null goes
   * back to the host's. Every plugin that reads one restarts with it.
   */
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

  /** Settings' Test button. */
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

  /** What the ready plugins find wrong now, for the heartbeat. One that can't be asked says so. */
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

  /** A call from the plugin's settings form. Works while it's starting up or needs setup, too. */
  async action(id: string, name: string, args: unknown): Promise<unknown> {
    const s = this.slots.get(id);
    const actions = s?.instance?.actions;
    // Its own actions only: not what every object has, such as "constructor".
    const fn = actions && Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (!s || !fn) throw new PluginError(`${s?.plugin.name ?? id} can't do "${name}" right now.`);
    return fn(args);
  }

  /**
   * The ready plugins in a stable order: it's part of the prompt cache. With `only`, just those a
   * bot may use.
   */
  private readyOnes(only: string[] | null) {
    return [...this.slots.values()]
      .filter((s) => s.state === "ready" && (!only || only.includes(s.plugin.id)))
      .sort((a, b) => a.plugin.id.localeCompare(b.plugin.id));
  }

  /** Tools of the ready plugins, for the chat and tasks. */
  tools(only: string[] | null = null): PluginTool[] {
    return this.readyOnes(only).flatMap((s) => s.instance?.tools ?? []);
  }

  /** The ready plugins' paragraphs for the system prompt. */
  guidance(only: string[] | null = null): string {
    return this.readyOnes(only)
      .flatMap((s) =>
        s.instance?.guidance ? `${s.plugin.name}\n${s.instance.guidance.trim()}` : [],
      )
      .join("\n\n");
  }

  /** The plugin a tool belongs to, by its name prefix. */
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
      enabled: stored.enabled === true,
      config: config.success ? config.data : plugin.config.parse({}),
    };
  }

  private async restart(s: Slot) {
    await this.stop(s);
    const generation = ++s.generation;
    s.state = "starting";
    s.message = null;
    this.emit(s);
    let instance: PluginInstance | null = null;
    let state: PluginState;
    let message: string | null = null;
    try {
      instance = await s.plugin.start({
        config: s.config,
        env: this.env(),
        named: s.plugin.named ? this.d.secrets.named(s.plugin.id) : {},
        db: this.d.db,
        files: this.d.files,
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
      // Switched off or restarted while starting.
      await instance?.stop?.();
      return;
    }
    s.instance = instance;
    s.state = state;
    s.message = message;
    this.emit(s);
    this.later(s);
  }

  /** Tries again later if it's in error or a part of it is down; forgets the tries once it works. */
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

  /** What a ready plugin offers now is checked like what it started with: a bad tool would fail every request. */
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

  private async stop(s: Slot) {
    s.generation++;
    if (s.retry) clearTimeout(s.retry);
    s.retry = null;
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
  }

  private checkTools(plugin: Plugin, tools: PluginTool[]) {
    const seen = new Set<string>();
    for (const t of tools) {
      if (!t.name.startsWith(`${plugin.id}_`) || !TOOL_NAME.test(t.name))
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

  /** What Settings is told of one variable: never a secret's value. */
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

/** A plugin's row in settings as saved: whether it's on, and its settings, unchecked. */
export function saved(db: Db, id: string): { enabled?: boolean; config?: unknown } {
  const row = getSetting(db, `plugin:${id}`);
  return row === null ? {} : JSON.parse(row);
}

/**
 * Whether a call's output is untrusted content. `input` is the parsed input; with `output`, once the
 * call has returned it.
 */
export const untrustedOf = (t: PluginTool, input: unknown, output?: string): boolean =>
  typeof t.untrusted === "function" ? t.untrusted(input, output) : Boolean(t.untrusted);

/**
 * Runs a plugin tool: checks its input, and labels untrusted output so it can't pose as instructions
 * (PLAN.md §6.1). Policy is the caller's job; this only runs it. `text`: the output without its label,
 * for screening.
 */
export async function runPluginTool(
  t: PluginTool,
  input: unknown,
  call: CallContext,
): Promise<{ content: string; isError: boolean; untrusted: boolean; text: string }> {
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) {
    const content = `Invalid input: ${z.prettifyError(parsed.error)}`;
    return { content, isError: true, untrusted: false, text: content };
  }
  const label = (text: string, untrusted: boolean) =>
    untrusted ? untrustedBlock("tool_output", text, { tool: t.name }) : text;
  let out: string;
  try {
    out = await t.run(parsed.data, call);
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
  return { content: label(out, untrusted), isError: false, untrusted, text: out };
}

/**
 * What taints a prompt that has these tools in it, or null: descriptions from untrusted MCP servers
 * that the owner hasn't accepted, or that changed since.
 */
export function untrustedDefinitions(tools: PluginTool[]): string | null {
  const servers = new Set(
    tools.filter((t) => t.untrustedDefinition).map((t) => t.name.split("_")[1]),
  );
  return servers.size
    ? `Tool descriptions from untrusted MCP servers, not accepted in Settings (${[...servers].join(", ")})`
    : null;
}

/** A tool call in a line, for the timeline and approvals. */
export function describeCall(t: PluginTool, input: unknown): string {
  const parsed = t.schema.safeParse(input);
  if (parsed.success && t.describe) return t.describe(parsed.data);
  return `${t.name} ${JSON.stringify(input ?? {})}`;
}

/**
 * Whether a call may run: the tool's own policy, made stricter by the untrusted-content rule. Once a
 * task or a conversation has read untrusted content, every write needs your approval (PLAN.md §6.1),
 * unless Haiku's review lets it through, or the tool's policy says an approval you gave covers it.
 */
export function verdictFor(
  t: PluginTool,
  input: unknown,
  call: CallContext,
  tainted = call.task?.tainted ?? false,
): Verdict {
  if (t.access === "read") return allow();
  const parsed = t.schema.safeParse(input);
  // Bad input fails in runPluginTool, before anything runs.
  if (!parsed.success) return allow();
  const own = t.policy ? t.policy(parsed.data, call) : allow();
  if (own.action !== "allow" || own.covered) return own;
  if (tainted)
    return {
      action: "ask",
      why: `This ${call.task ? "task" : "conversation"} has read untrusted content, so changes need your approval.`,
      tainted: true,
      ...(t.kind ? { kind: t.kind } : {}),
    };
  return own;
}
