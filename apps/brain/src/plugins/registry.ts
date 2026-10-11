// Starts the plugins you've switched on, keeps their settings, and hands their tools to the chat and
// to tasks (PLAN.md §4.5).
import type { PluginInfo, PluginState } from "@hatbot/shared";
import { z } from "zod";
import type { Db } from "../db";
import type { EventBus } from "../events";
import {
  allow,
  type CallContext,
  type Plugin,
  PluginError,
  type PluginInstance,
  type PluginTool,
  type Verdict,
} from "./plugin";

/** What a model gets to see of one tool's output. */
const MAX_OUTPUT_CHARS = 30_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

type Slot = {
  plugin: Plugin;
  enabled: boolean;
  config: unknown;
  state: PluginState;
  message: string | null;
  instance: PluginInstance | null;
  /** Bumped on every (re)start, so a slow start that was overtaken is thrown away. */
  generation: number;
};

export type PluginsDeps = {
  db: Db;
  events: EventBus;
  env?: Record<string, string | undefined>;
  /** The core's own tool names; plugin tools can't take them. */
  reserved: string[];
};

export class Plugins {
  private slots = new Map<string, Slot>();
  private env: Record<string, string | undefined>;

  constructor(
    plugins: Plugin[],
    private d: PluginsDeps,
  ) {
    this.env = d.env ?? process.env;
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
    this.d.db
      .query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(`plugin:${id}`, JSON.stringify({ enabled: s.enabled, config: s.config }));
    if (s.enabled) await this.restart(s);
    else await this.stop(s);
    return this.info(s);
  }

  /** Settings' Test button. */
  async test(id: string): Promise<string> {
    const s = this.slots.get(id);
    if (!s) throw new PluginError(`No plugin "${id}".`);
    if (s.state !== "ready" || !s.instance) throw new PluginError(`${s.plugin.name} isn't ready.`);
    if (!s.instance.test) throw new PluginError(`${s.plugin.name} has no test.`);
    return s.instance.test();
  }

  /** A call from the plugin's settings form. Works while it's starting up or needs setup, too. */
  async action(id: string, name: string, args: unknown): Promise<unknown> {
    const s = this.slots.get(id);
    const fn = s?.instance?.actions?.[name];
    if (!s || !fn) throw new PluginError(`${s?.plugin.name ?? id} can't do "${name}" right now.`);
    return fn(args);
  }

  /**
   * Tools of the ready plugins, in a stable order (it's part of the prompt cache). The chat gets the
   * read tools; tasks get all of them.
   */
  tools(scope: "chat" | "task"): PluginTool[] {
    return [...this.slots.values()]
      .filter((s) => s.state === "ready" && s.instance)
      .sort((a, b) => a.plugin.id.localeCompare(b.plugin.id))
      .flatMap((s) => s.instance?.tools ?? [])
      .filter((t) => scope === "task" || t.access === "read");
  }

  /** The ready plugins' paragraphs for the system prompt. */
  guidance(): string {
    return [...this.slots.values()]
      .filter((s) => s.state === "ready" && s.instance?.guidance)
      .sort((a, b) => a.plugin.id.localeCompare(b.plugin.id))
      .map((s) => `${s.plugin.name}\n${s.instance?.guidance?.trim()}`)
      .join("\n\n");
  }

  /** The plugin a tool belongs to, by its name prefix. */
  pluginOf(toolName: string): Plugin | null {
    return this.slots.get(toolName.split("_")[0] ?? "")?.plugin ?? null;
  }

  private load(plugin: Plugin): { enabled: boolean; config: unknown } {
    const row = this.d.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(`plugin:${plugin.id}`);
    const stored = row ? (JSON.parse(row.value) as { enabled?: boolean; config?: unknown }) : {};
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
      instance = await s.plugin.start({ config: s.config, env: this.env, db: this.d.db });
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
  }

  private async stop(s: Slot) {
    s.generation++;
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
      message: s.message,
      secrets: (s.plugin.secrets ?? []).map((name) => ({ name, set: Boolean(this.env[name]) })),
      config: s.config,
      tools: (s.instance?.tools ?? []).map((t) => ({
        name: t.name,
        access: t.access,
        description: t.description,
      })),
      testable: Boolean(s.instance?.test),
    };
  }

  private emit(s: Slot) {
    this.d.events.emit({ type: "plugin.updated", plugin: this.info(s) });
  }
}

/**
 * Runs a plugin tool: checks its input, and labels untrusted output so it can't pose as instructions
 * (PLAN.md §6.1). Policy is the caller's job; this only runs it.
 */
export async function runPluginTool(
  t: PluginTool,
  input: unknown,
  call: CallContext,
): Promise<{ content: string; isError: boolean; untrusted: boolean }> {
  const parsed = t.schema.safeParse(input);
  if (!parsed.success)
    return {
      content: `Invalid input: ${z.prettifyError(parsed.error)}`,
      isError: true,
      untrusted: false,
    };
  const untrusted =
    typeof t.untrusted === "function" ? t.untrusted(parsed.data) : Boolean(t.untrusted);
  const label = (text: string) =>
    untrusted
      ? `<tool_output tool="${t.name}" trusted="false">\n${JSON.stringify(text)}\n</tool_output>`
      : text;
  let out: string;
  try {
    out = await t.run(parsed.data, call);
  } catch (err) {
    if (call.signal.aborted) throw err;
    // An untrusted source's error message is untrusted too.
    if (err instanceof PluginError)
      return { content: label(err.message), isError: true, untrusted };
    console.error(`tool ${t.name} failed`, err);
    return { content: "The tool failed with an internal error.", isError: true, untrusted: false };
  }
  if (out.length > MAX_OUTPUT_CHARS)
    out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n… (cut; ${out.length} characters in all)`;
  return { content: label(out), isError: false, untrusted };
}

/** A tool call in a line, for the timeline and approvals. */
export function describeCall(t: PluginTool, input: unknown): string {
  const parsed = t.schema.safeParse(input);
  if (parsed.success && t.describe) return t.describe(parsed.data);
  return `${t.name} ${JSON.stringify(input ?? {})}`;
}

/**
 * Whether a call may run: the tool's own policy, made stricter by the untrusted-content rule. Once a
 * task has read untrusted content, every write needs your approval (PLAN.md §6.1).
 */
export function verdictFor(t: PluginTool, input: unknown, call: CallContext): Verdict {
  if (t.access === "read") return allow();
  const parsed = t.schema.safeParse(input);
  // Bad input fails in runPluginTool, before anything runs.
  if (!parsed.success) return allow();
  const own = t.policy ? t.policy(parsed.data, call) : allow();
  if (own.action !== "allow") return own;
  if (call.task?.tainted)
    return {
      action: "ask",
      why: "This task has read untrusted content, so changes need your approval.",
      tainted: true,
    };
  return own;
}
