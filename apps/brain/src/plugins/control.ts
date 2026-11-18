// Plugins as a bot changes them, in guided setup or with the plugins_ tools: on or off, their settings,
// and which bots have them. Secrets, installs, the models' provider and owner-only marks stay the owner's.
import { clip, PluginError } from "@hatbot/plugin-sdk";
import { type PluginField, type PluginInfo, SetPluginSecrets } from "@hatbot/shared";
import { z } from "zod";
import type { Bots } from "../bots";
import type { Secrets } from "../secrets";
import type { SettingsStore } from "../settings";
import type { Plugins } from "./registry";

export const PluginChange = z.object({
  id: z.string().min(1).max(40).describe("The plugin's id"),
  on: z.boolean().optional().describe("Turn it on or off"),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Only the settings that change, in its own shape; a list is replaced whole"),
  values: SetPluginSecrets.shape.values
    .optional()
    .describe(
      "Values it reads that aren't secret, such as an address, by name; null goes back to the host's",
    ),
});
export type PluginChange = z.infer<typeof PluginChange>;

export const BotPlugins = z.object({
  bot: z.string().min(1).max(40).describe("The bot's id; Hatbot's is hatbot"),
  plugins: z
    .array(z.string().min(1).max(40))
    .max(50)
    .nullable()
    .describe("Every plugin it should have, by id; null for every plugin that's on"),
});
export type BotPlugins = z.infer<typeof BotPlugins>;

const SHOWN_CHARS = 300;

export const stateText = (p: PluginInfo) =>
  !p.enabled
    ? "off"
    : p.state === "ready"
      ? "ready"
      : `${p.state.replace("_", " ")}${p.message ? `: ${p.message}` : ""}`;

const notInstalled = (id: string) =>
  `There's no plugin "${id}". Installing one is for the owner, in Settings → Plugins.`;

export class PluginControl {
  constructor(
    private d: { plugins: Plugins; bots: Bots; settings: SettingsStore; secrets: Secrets },
  ) {}

  list(): string {
    return (
      this.d.plugins
        .list()
        .map((p) => {
          const state = p.enabled ? `on, ${stateText(p)}` : "off";
          return `- ${p.name} (${p.id}): ${state}.${p.description ? ` ${p.description}.` : ""}`;
        })
        .join("\n") || "No plugins."
    );
  }

  settingsOf(id: string): string {
    const p = this.d.plugins.get(id);
    if (!p) return this.d.plugins.partOfHatbot(id) ? partOf(id) : notInstalled(id);
    const fields = p.form.flatMap((f) => fieldLines(f));
    const values = p.env.map((e) => {
      const optional = e.optional ? ", optional" : "";
      if (e.secret) return `- ${e.name}: secret, ${e.set ? "set" : "not set"}${optional}`;
      const hint = e.hint && !e.set ? ` (like ${e.hint})` : "";
      return `- ${e.name}: ${e.value ?? "not set"}${hint}${optional}`;
    });
    const text = [
      `${p.name} (${p.id}): ${p.enabled ? `on, ${stateText(p)}` : "off"}.`,
      `Settings: ${JSON.stringify(p.config)}`,
      ...(fields.length ? ["Fields:", ...fields] : []),
      ...(values.length ? ["Values it reads:", ...values] : []),
      ...(p.named ? [`Secrets set by name on its page: ${p.named.join(", ") || "none"}.`] : []),
      ...(p.testable ? ["It has a test."] : []),
      ...(p.env.some((e) => /set when you connect/i.test(e.hint ?? ""))
        ? ["It signs in with Connect on its page."]
        : []),
      `The owner sets its secrets on its page, in Settings → Plugins → ${p.name}.`,
    ].join("\n");
    return this.hide(text);
  }

  bots(): string {
    const { plugins, bots } = this.d;
    const name = (id: string) => plugins.get(id)?.name ?? id;
    const lines = bots.list().map((b) => {
      const left = b.plugins === null ? bots.leftToOthers(b).map(name) : [];
      const has =
        b.plugins === null
          ? `every plugin that's on${left.length ? `, but ${left.join(", ")} (another bot's)` : ""}`
          : b.plugins.map(name).join(", ") || "none of its own";
      return `- ${b.name} (${b.id}): ${has}`;
    });
    const every = plugins.forEveryBot().map(name);
    return [...lines, ...(every.length ? [`Every bot has ${every.join(", ")} too.`] : [])].join(
      "\n",
    );
  }

  /** What its test says, or why it failed. */
  async test(id: string): Promise<string> {
    if (!this.d.plugins.get(id)) return notInstalled(id);
    try {
      return await this.d.plugins.test(id);
    } catch (err) {
      if (err instanceof PluginError) return `The test failed: ${err.message}`;
      console.error("plugin test failed", err);
      return "The test failed.";
    }
  }

  /** Why a bot can't make this change, or null. */
  problem(c: PluginChange): string | null {
    const { plugins } = this.d;
    if (plugins.partOfHatbot(c.id)) return partOf(c.id);
    const p = plugins.get(c.id);
    if (!p) return notInstalled(c.id);
    const page = `on ${p.name}'s page in Settings → Plugins`;
    const sets = Boolean(c.config) || Object.keys(c.values ?? {}).length > 0;
    if ((sets || (c.on === false && p.enabled)) && this.servesModels(p.id))
      return `${p.name} gives the models Hatbot runs on: the owner changes it ${page}.`;
    for (const name of Object.keys(c.values ?? {})) {
      const v = p.env.find((e) => e.name === name);
      if (p.named || v?.secret) return `${name} is secret: the owner enters it ${page}.`;
      if (!v) return `${p.name} doesn't read ${name}.`;
      if (plugins.ownersValues(p.id).includes(name))
        return `${name} keeps something safe: the owner sets it ${page}.`;
    }
    if (c.config) {
      const after = plugins.parseConfig(p.id, merged(p.config, c.config));
      if (!after?.success) return issueText(p, after?.error);
      const owners = plugins.ownerOnly(p.id, after.data);
      if (owners) return owners;
    }
    if (!this.lines(p, c).length)
      return `Nothing would change: ${p.name} is set like that already.`;
    return null;
  }

  /** The change in plain words, old values beside new ones, as the owner approves it. */
  describe(c: PluginChange): string {
    const p = this.d.plugins.get(c.id);
    if (!p) return `Change plugin ${c.id}`;
    const lines = this.lines(p, c);
    if (lines.length === 1 && c.on !== undefined && lines[0]?.startsWith("turn"))
      return `Turn ${c.on ? "on" : "off"} ${p.name}`;
    return this.hide(`Change ${p.name}: ${lines.join("; ") || "nothing"}`);
  }

  async change(c: PluginChange): Promise<string> {
    const { plugins } = this.d;
    const why = this.problem(c);
    if (why) throw new PluginError(why);
    const p = plugins.get(c.id) as PluginInfo;
    const lines = this.lines(p, c);
    const values = Object.entries(c.values ?? {}).filter(
      ([k, v]) => (v ?? null) !== p.env.find((e) => e.name === k)?.value,
    );
    if (values.length) await plugins.setSecrets(p.id, Object.fromEntries(values));
    const on = c.on === undefined || c.on === p.enabled ? undefined : c.on;
    if (c.config || on !== undefined)
      await plugins.update(p.id, {
        enabled: on,
        config: c.config ? merged(p.config, c.config) : undefined,
      });
    const now = plugins.get(p.id) ?? p;
    return this.hide(`Changed ${p.name}: ${lines.join("; ")}. It's ${stateText(now)}.`);
  }

  /** Why a bot can't be given these plugins, or null. */
  idsProblem(ids: string[] | null): string | null {
    for (const id of ids ?? []) {
      if (this.d.plugins.partOfHatbot(id)) return `${id} is part of Hatbot: every bot has it.`;
      if (!this.d.plugins.get(id)) return notInstalled(id);
    }
    return null;
  }

  botProblem(b: BotPlugins): string | null {
    const bot = this.d.bots.active(b.bot);
    if (!bot) return `There's no bot "${b.bot}".`;
    const wrong = this.idsProblem(b.plugins);
    if (wrong) return wrong;
    return sameList(bot.plugins, b.plugins) ? `${bot.name} has those plugins already.` : null;
  }

  describeBot(b: BotPlugins): string {
    const bot = this.d.bots.active(b.bot);
    if (!bot) return `Change bot ${b.bot}'s plugins`;
    const names = (ids: string[]) => ids.map((id) => this.d.plugins.get(id)?.name ?? id).join(", ");
    const was = bot.plugins;
    const now = b.plugins;
    if (now === null)
      return `${bot.name} gets every plugin that's on, not only ${names(was ?? [])}`;
    if (was === null)
      return `${bot.name} gets only ${names(now) || "none"}, not every plugin that's on`;
    const added = now.filter((id) => !was.includes(id));
    const removed = was.filter((id) => !now.includes(id));
    return [
      added.length ? `Give ${bot.name} ${names(added)}` : "",
      removed.length
        ? `${added.length ? "take" : `Take ${bot.name}'s`} ${names(removed)} away`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
  }

  setBot(b: BotPlugins): string {
    const why = this.botProblem(b);
    if (why) throw new PluginError(why);
    const what = this.describeBot(b);
    this.d.bots.update(b.bot, { plugins: b.plugins });
    return `Done: ${what}.`;
  }

  /** What would change, each as "what: old → new". */
  private lines(p: PluginInfo, c: PluginChange): string[] {
    const out: string[] = [];
    if (c.on !== undefined && c.on !== p.enabled) out.push(c.on ? "turn it on" : "turn it off");
    if (c.config) {
      const after = this.d.plugins.parseConfig(p.id, merged(p.config, c.config));
      if (after?.success) out.push(...configLines(p, p.config, after.data));
    }
    for (const [name, v] of Object.entries(c.values ?? {})) {
      const was = p.env.find((e) => e.name === name)?.value ?? null;
      if ((v ?? null) !== was) out.push(`${name}: ${was ?? "not set"} → ${v ?? "the host's"}`);
    }
    return out;
  }

  /** Secrets anyone typed into a setting as they are, such as an MCP header's, as [hidden]. */
  private hide(text: string): string {
    return this.d.secrets.hiderForExport(this.d.plugins.secretValues())(text);
  }

  /** A provider whose models are among those Hatbot or a bot runs on. */
  private servesModels(id: string): boolean {
    const s = this.d.settings.get();
    const used = new Set([
      s.chatModel,
      s.taskModel,
      s.desktopModel,
      s.smallModel,
      s.expertModel,
      ...this.d.bots.list().flatMap((b) => b.chatModel ?? []),
    ]);
    const provider = this.d.plugins.modelProviders().find((m) => m.id === id)?.provider;
    return Boolean(provider?.models().some((m) => used.has(m.id)));
  }
}

const partOf = (id: string) => `"${id}" is part of Hatbot: it's always on, with nothing to set.`;

const sameList = (a: string[] | null, b: string[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((x) => b.includes(x));

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `patch` over `base`, object by object; anything else in it replaces what was there. */
function merged(base: unknown, patch: unknown): unknown {
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merged(base[k], v);
  return out;
}

function fieldLines(f: PluginField, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const choices = "choices" in f ? f.choices.map((c) => c.value).join(", ") : "";
  const kind =
    f.kind === "switch"
      ? "on or off"
      : f.kind === "choice"
        ? `one of ${choices}`
        : f.kind === "picks"
          ? `any of ${choices}`
          : f.kind === "list"
            ? `a list of ${f.numbers ? "numbers" : "text"}`
            : f.kind === "group"
              ? "a group"
              : f.kind;
  const line = `${pad}- ${f.path.join(".")}: ${f.label} (${kind})`;
  return f.kind === "group" ? [line, ...f.fields.flatMap((x) => fieldLines(x, depth + 1))] : [line];
}

function labelsOf(fields: PluginField[], into = new Map<string, string>()) {
  for (const f of fields) {
    into.set(f.path.join("."), f.label);
    if (f.kind === "group") labelsOf(f.fields, into);
  }
  return into;
}

const leaves = (v: unknown, at: string[] = []): [string, unknown][] =>
  isPlain(v) && Object.keys(v).length
    ? Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, k]))
    : [[at.join("."), v]];

function shown(v: unknown): string {
  if (v === undefined || v === null || v === "") return "not set";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null))
    return v.length ? v.join(", ") : "none";
  return clip(typeof v === "string" ? v : JSON.stringify(v), SHOWN_CHARS);
}

/** Lists of objects (SSH's hosts) as what's added and taken out, each whole. */
function listChange(was: unknown, now: unknown): string | null {
  const objects = (v: unknown) =>
    Array.isArray(v) && v.some((x) => typeof x === "object" && x !== null);
  if (!objects(was) && !objects(now)) return null;
  const json = (v: unknown) => (Array.isArray(v) ? v.map((x) => JSON.stringify(x)) : []);
  const before = json(was);
  const after = json(now);
  const added = after.filter((x) => !before.includes(x)).map((x) => clip(x, SHOWN_CHARS));
  const removed = before.filter((x) => !after.includes(x)).map((x) => clip(x, SHOWN_CHARS));
  return [
    added.length ? `add ${added.join(", ")}` : "",
    removed.length ? `take out ${removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function configLines(p: PluginInfo, before: unknown, after: unknown): string[] {
  const labels = labelsOf(p.form);
  const was = new Map(leaves(before));
  const now = new Map(leaves(after));
  const paths = [...new Set([...was.keys(), ...now.keys()])];
  return paths.flatMap((path) => {
    const a = was.get(path);
    const b = now.get(path);
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    const label = labels.get(path) ?? (path || "Settings");
    const list = listChange(a, b);
    return [list ? `${label}: ${list}` : `${label}: ${shown(a)} → ${shown(b)}`];
  });
}

function issueText(p: PluginInfo, error: z.ZodError | undefined): string {
  const issue = error?.issues[0];
  if (!issue) return "Those settings aren't right.";
  const path = issue.path.map(String).join(".");
  const label = labelsOf(p.form).get(path) ?? path;
  const text = `${label ? `${label}: ` : ""}${issue.message}`;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
