// The guided setup: the provider's form, then an interview on the expert model whose tools change
// settings, plugins, bots and memory directly. Its transcript lives only here, until it's finished.
import type Anthropic from "@anthropic-ai/sdk";
import {
  BudgetError,
  containerOf,
  cutOff,
  estimateTokens,
  fixedTokens,
  invalidInput,
  modelErrorText,
  PluginError,
  serverToolWaiting,
  toolParam,
  webTools,
} from "@hatbot/plugin-sdk";
import {
  BOT_COLORS,
  BOT_ICONS,
  CreateBot,
  type Onboarding as OnboardingState,
  SETUP_TOPIC_NAMES,
  SETUP_TOPICS,
  SetNtfy,
  type SetupEvent,
  type SetupField,
  type SetupItem,
  type SetupModels,
  type SetupTopic,
  type SetupTopicState,
  type SetupTurn,
  UpdateBot,
} from "@hatbot/shared";
import { z } from "zod";
import type { Chats } from "../agent/chats";
import type { ModelClient } from "../agent/model";
import type { Models } from "../agent/models";
import type { Bots } from "../bots";
import type { Checks } from "../checks";
import type { Db } from "../db";
import { UserError } from "../errors";
import type { EventBus } from "../events";
import type { MemoryStore } from "../memory/store";
import { modelProblem } from "../models-known";
import { guessableTopic } from "../notify";
import type { Plugins } from "../plugins/registry";
import type { Secrets } from "../secrets";
import {
  getSetting,
  type Settings,
  SettingsPatch,
  type SettingsStore,
  setSetting,
} from "../settings";
import { requestCeiling, type Spend } from "../spend";
import { SETUP_PROMPT } from "./prompt";
import { rolesFor } from "./roles";

const MAX_STEPS = 16;
const MAX_TOKENS = 16000;
const WEB_USES = 5;
const PAGE_TOKENS = 10_000;
const MEMORY_FILES = ["about-you.md", "preferences.md"] as const;

export type OnboardingDeps = {
  db: Db;
  settings: SettingsStore;
  events: EventBus;
  spend: Spend;
  model: ModelClient;
  models: Models;
  plugins: Plugins;
  bots: Bots;
  chats: Chats;
  memory: MemoryStore;
  checks: Checks;
  secrets: Secrets;
  local: boolean;
  /** Tests' models answer without a provider. */
  modelsReady?: () => boolean;
};

type Saved = { finished?: boolean; topics?: Partial<Record<SetupTopic, SetupTopicState>> };

/** A tool call that waits for the owner: its result is their answer, sent with their next turn. */
type Pending = {
  toolUseId: string;
  kind: "ask" | "secrets" | "connect";
  itemId?: string;
  /** The other calls' results from the same response. */
  results: Anthropic.Beta.BetaContentBlockParam[];
};

type Emit = (e: SetupEvent) => void;

type Outcome = { text: string } | { error: string } | { waits: Pending["kind"]; itemId?: string };

const Look = z.object({
  what: z.enum(["settings", "plugins", "bots", "memory", "models", "topics"]),
});
const ChangeSettings = z.object({
  changes: z
    .record(z.string(), z.unknown())
    .describe(
      "Only what changes, in the settings' own shape (see look settings). limits and safety.kinds may change one field at a time; safety.tools is replaced whole.",
    ),
});
const SwitchPlugin = z.object({ id: z.string(), on: z.boolean() });
const SetPlugin = z.object({
  id: z.string(),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Its whole settings, as look shows them"),
  values: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Its values that aren't secret, such as an address; a secret goes through ask_secrets",
    ),
});
const PluginId = z.object({ id: z.string() });
const AskSecrets = z.object({
  plugin: z.string().describe('The plugin\'s id, or "ntfy" for notifications'),
  why: z.string().max(300).describe("One line on what it's for and where to find it"),
});
const MakeBot = CreateBot.pick({
  name: true,
  icon: true,
  color: true,
  instructions: true,
  plugins: true,
});
const ChangeBot = UpdateBot.pick({
  name: true,
  icon: true,
  color: true,
  instructions: true,
  plugins: true,
}).extend({ id: z.string() });
const WriteMemory = z.object({
  file: z.enum(MEMORY_FILES),
  content: z.string().max(20_000).describe("The whole file, with what was there kept"),
});
const Topic = z.object({ topic: z.enum(SETUP_TOPICS), state: z.enum(["done", "skipped"]) });
const Ask = z.object({
  question: z.string().min(1).max(1000),
  choices: z.array(z.string().min(1).max(60)).min(2).max(6),
});

const TOOLS = [
  { name: "look", description: "See what's set now.", schema: Look },
  { name: "change_settings", description: "Change Hatbot's settings.", schema: ChangeSettings },
  { name: "switch_plugin", description: "Turn a plugin on or off.", schema: SwitchPlugin },
  {
    name: "set_plugin",
    description: "Change a plugin's settings, or its values that aren't secret.",
    schema: SetPlugin,
  },
  {
    name: "test_plugin",
    description: "Try a plugin that's ready, as its Test button does.",
    schema: PluginId,
  },
  {
    name: "ask_secrets",
    description:
      "Show the owner a form for a plugin's keys and tokens (or ntfy's), and end your turn. Its values go straight to Hatbot; you're told whether they were saved and work.",
    schema: AskSecrets,
  },
  {
    name: "connect",
    description:
      "Show a Connect button for a plugin that signs in to its service, and end your turn. Set its address first if it has one.",
    schema: PluginId,
  },
  {
    name: "check_everything",
    description:
      "Run Check everything: each part Hatbot depends on, tried for real. Takes a few seconds.",
    schema: z.object({}),
  },
  {
    name: "make_bot",
    description: `Make a bot. Icons: ${BOT_ICONS.join(", ")}. Colours: ${BOT_COLORS.join(", ")}. plugins: their ids, or null for all that are on.`,
    schema: MakeBot,
  },
  { name: "change_bot", description: "Change a bot (Hatbot's id is hatbot).", schema: ChangeBot },
  {
    name: "write_memory",
    description: "Write one of the owner's memory files whole.",
    schema: WriteMemory,
  },
  { name: "topic", description: "Mark a topic done, or skipped.", schema: Topic },
  {
    name: "ask",
    description: "Ask one question with a few likely answers as buttons, and end your turn.",
    schema: Ask,
  },
];

const NTFY_FIELDS: SetupField[] = [
  { name: "url", hint: "https://ntfy.sh", optional: false, secret: false },
  { name: "topic", hint: "A long random name", optional: false, secret: false },
  { name: "token", hint: "Only for a server that needs one", optional: true, secret: true },
];

export class Onboarding {
  private items: SetupItem[] = [];
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private pending: Pending | null = null;
  private busy = false;
  private container: string | undefined;
  private ids = 0;

  constructor(private d: OnboardingDeps) {}

  private saved(): Saved {
    return JSON.parse(getSetting(this.d.db, "onboarding") ?? "{}") as Saved;
  }

  private save(s: Saved) {
    setSetting(this.d.db, "onboarding", JSON.stringify(s));
  }

  finished(): boolean {
    return this.saved().finished === true;
  }

  private topics(): Record<SetupTopic, SetupTopicState> {
    const s = this.saved().topics ?? {};
    return Object.fromEntries(SETUP_TOPICS.map((t) => [t, s[t] ?? "todo"])) as Record<
      SetupTopic,
      SetupTopicState
    >;
  }

  private needsModels(): boolean {
    if (this.d.modelsReady) return !this.d.modelsReady();
    const expert = this.d.settings.get().expertModel;
    return !this.d.models.catalogue().some((m) => m.id === expert);
  }

  state(): OnboardingState {
    return {
      finished: this.finished(),
      needsModels: this.needsModels(),
      topics: this.topics(),
      items: this.items,
      busy: this.busy,
    };
  }

  /** Saved only once it works: a key that fails leaves what was there. */
  async setModels(input: z.infer<typeof SetupModels>): Promise<OnboardingState> {
    const { plugins, secrets, settings } = this.d;
    const id = input.provider;
    const info = plugins.get(id);
    if (!info) throw new UserError("That provider isn't installed.");
    const values: Record<string, string | null> =
      id === "anthropic"
        ? { ANTHROPIC_API_KEY: input.key }
        : { OPENAI_API_KEY: input.key, OPENAI_BASE_URL: input.baseUrl ?? null };
    const before = secrets.pluginEnv();
    const was = Object.fromEntries(Object.keys(values).map((k) => [k, before[k] ?? null]));
    await plugins.setSecrets(id, values);
    if (!info.enabled) await plugins.update(id, { enabled: true });
    const failed = async (why: string) => {
      await plugins.setSecrets(id, was);
      if (!info.enabled) await plugins.update(id, { enabled: false });
      throw Object.assign(new UserError(why), { field: "key" });
    };
    const now = plugins.get(id);
    if (now?.state !== "ready") return failed(now?.message ?? "It didn't start.");
    try {
      await plugins.test(id);
    } catch (err) {
      return failed(err instanceof PluginError ? err.message : "The key didn't work.");
    }
    const offered = this.d.models.catalogue().filter((m) => m.provider === id);
    const roles = rolesFor(offered, settings.get());
    const next = settings.update(roles);
    this.d.events.emit({ type: "settings.updated", settings: next });
    return this.state();
  }

  /** Throws what's wrong with a turn before it starts, so the route can answer with it. */
  check(turn: SetupTurn) {
    if (this.busy) throw new UserError("Hatbot is still answering.", 409);
    if (this.needsModels()) throw new UserError("Set up a model provider first.", 409);
    if ("secrets" in turn || "connected" in turn) {
      const id = "secrets" in turn ? turn.secrets.id : turn.connected.id;
      if (this.pending?.itemId !== id) throw new UserError("That's no longer open.");
    }
  }

  async turn(turn: SetupTurn, emit: Emit): Promise<void> {
    this.check(turn);
    this.busy = true;
    const add = (item: SetupItem) => {
      this.items.push(item);
      emit({ type: "item", item });
    };
    try {
      const fresh = !this.messages.length && !("start" in turn);
      const content = await this.answer(turn, add);
      if (content && fresh) content.unshift({ type: "text", text: await this.opening("") });
      if (content) await this.run(content, emit, add);
    } finally {
      this.busy = false;
      emit({ type: "state", onboarding: this.state() });
    }
  }

  finish(): OnboardingState {
    if (this.busy) throw new UserError("Hatbot is still answering.", 409);
    this.save({ ...this.saved(), finished: true });
    this.forget();
    return this.state();
  }

  /** From Settings: a new interview, every topic to do again. Setup stays finished. */
  again(): OnboardingState {
    if (this.busy) throw new UserError("Hatbot is still answering.", 409);
    this.save({ finished: this.finished(), topics: {} });
    this.forget();
    return this.state();
  }

  private forget() {
    this.items = [];
    this.messages = [];
    this.pending = null;
    this.container = undefined;
  }

  /** What the owner's turn sends the model, after doing what it asks; null for nothing. */
  private async answer(
    turn: SetupTurn,
    add: (item: SetupItem) => void,
  ): Promise<Anthropic.Beta.BetaContentBlockParam[] | null> {
    const pending = this.pending;
    this.pending = null;
    const resolve = (text: string) =>
      pending
        ? [
            ...pending.results,
            { type: "tool_result" as const, tool_use_id: pending.toolUseId, content: text },
          ]
        : [{ type: "text" as const, text }];
    const leave = () => {
      if (pending?.itemId) this.setItem(pending.itemId, { state: "skipped" });
    };
    if ("start" in turn) {
      if (this.messages.length) {
        this.pending = pending;
        return null;
      }
      return [{ type: "text", text: await this.opening(turn.start.timezone) }];
    }
    if ("say" in turn) {
      add({ kind: "owner", text: turn.say });
      leave();
      return resolve(
        pending?.kind === "ask" || !pending
          ? turn.say
          : `The owner didn't fill that in, and wrote: ${turn.say}`,
      );
    }
    if ("skip" in turn) {
      this.setTopic(turn.skip, "skipped");
      add({ kind: "owner", text: `Skip ${SETUP_TOPIC_NAMES[turn.skip].toLowerCase()}` });
      leave();
      return resolve(`The owner skipped ${turn.skip}. Go on to the next topic still to do.`);
    }
    if ("secrets" in turn) {
      const { id, values } = turn.secrets;
      if (!values) {
        this.setItem(id, { state: "skipped" });
        add({ kind: "owner", text: "Skip" });
        return resolve("The owner skipped the form.");
      }
      const item = this.items.find((i) => i.kind === "secrets" && i.id === id);
      const target = item?.kind === "secrets" ? item.title : "";
      const said = await this.saveSecrets(id, values, add);
      return resolve(said ?? `Saved ${target}.`);
    }
    const { id, error } = turn.connected;
    this.setItem(id, { state: error ? "skipped" : "done" });
    const item = this.items.find((i) => i.kind === "connect" && i.id === id);
    const name = item?.kind === "connect" ? item.title : "it";
    if (!error) add({ kind: "change", text: `Connected ${name}` });
    return resolve(error ? `It didn't connect: ${error}` : `Connected ${name}.`);
  }

  private async opening(browserTz: string): Promise<string> {
    const s = this.d.settings.get();
    const topics = this.topics();
    const left = SETUP_TOPICS.filter((t) => topics[t] === "todo");
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return [
      "<setup_start>",
      `Their browser's timezone: ${browserTz || "unknown"}. Hatbot's now: ${s.timezone || `${machine} (the machine's)`}.`,
      this.d.local
        ? "Hatbot runs on the owner's own computer (local mode): there's no desktop or boxes guest."
        : "Hatbot runs on the owner's server.",
      `Topics still to do: ${left.join(", ") || "none"}.`,
      `Their name in settings: ${s.owner.name}.`,
      "</setup_start>",
      "Greet them in a line and start.",
    ].join("\n");
  }

  private setItem(id: string, patch: { state: string }) {
    this.items = this.items.map((i) =>
      "id" in i && i.id === id ? ({ ...i, ...patch } as SetupItem) : i,
    );
  }

  private setTopic(topic: SetupTopic, state: SetupTopicState) {
    const s = this.saved();
    this.save({ ...s, topics: { ...s.topics, [topic]: state } });
  }

  private newId() {
    return `s${++this.ids}`;
  }

  /** null when saved and, where there's a test, working; otherwise what went wrong. */
  private async saveSecrets(
    itemId: string,
    values: Record<string, string>,
    add: (item: SetupItem) => void,
  ): Promise<string | null> {
    const item = this.items.find((i) => i.kind === "secrets" && i.id === itemId);
    if (item?.kind !== "secrets") return "That form is gone.";
    const filled = Object.fromEntries(
      Object.entries(values)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([k, v]) => v && item.fields.some((f) => f.name === k)),
    );
    const plugin = this.d.plugins.get(item.plugin);
    if (!plugin) {
      const ntfy = SetNtfy.safeParse(filled);
      if (!ntfy.success) return `Not saved: ${invalidInput(ntfy.error)}`;
      if (guessableTopic(ntfy.data.topic))
        return "Not saved: that topic is easy to guess. Ask for a long random one.";
      this.d.secrets.setNtfy(ntfy.data);
      this.setItem(itemId, { state: "saved" });
      add({ kind: "change", text: "Set up ntfy for notifications" });
      return "Saved ntfy. Its notifications go out from now on.";
    }
    try {
      await this.d.plugins.setSecrets(plugin.id, filled);
    } catch (err) {
      if (err instanceof PluginError) return `Not saved: ${err.message}`;
      throw err;
    }
    this.setItem(itemId, { state: "saved" });
    add({ kind: "change", text: `Saved ${plugin.name}'s ${Object.keys(filled).join(", ")}` });
    const now = this.d.plugins.get(plugin.id);
    if (now?.state !== "ready")
      return `Saved, but ${plugin.name} isn't ready${now?.message ? `: ${now.message}` : "."}`;
    if (!now.testable) return `Saved; ${plugin.name} is ready.`;
    return `Saved. Its test: ${await this.test(plugin.id)}`;
  }

  private async test(id: string): Promise<string> {
    try {
      return await this.d.plugins.test(id);
    } catch (err) {
      if (err instanceof PluginError) return err.message;
      console.error("plugin test failed", err);
      return "The test failed.";
    }
  }

  private async run(
    first: Anthropic.Beta.BetaContentBlockParam[],
    emit: Emit,
    add: (item: SetupItem) => void,
  ) {
    const { spend, settings } = this.d;
    const model = settings.get().expertModel;
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      ...TOOLS.map(toolParam),
      ...webTools({ pageTokens: PAGE_TOKENS, uses: WEB_USES }),
    ];
    const system = [
      { type: "text" as const, text: SETUP_PROMPT, cache_control: { type: "ephemeral" as const } },
    ];
    this.pushUser(first);
    for (let n = 0; n < MAX_STEPS; n++) {
      let release: () => void;
      try {
        release = spend.hold(
          requestCeiling(model, {
            prompt: estimateTokens(this.messages) + fixedTokens(system, tools),
            write: "5m",
            maxTokens: MAX_TOKENS,
            webSearches: WEB_USES,
          }),
        );
      } catch (err) {
        if (err instanceof BudgetError) return add({ kind: "error", text: err.message });
        throw err;
      }
      const record = (m: string, usage: Anthropic.Beta.BetaUsage) =>
        spend.recordResponse({ model: m, purpose: "setup", usage });
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await this.d.model.stream(
          {
            model,
            max_tokens: MAX_TOKENS,
            system,
            cache_control: { type: "ephemeral" },
            tools,
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            ...(this.container ? { container: this.container } : {}),
            messages: this.messages,
          },
          { onText: (text) => emit({ type: "text", text }), onFailedUsage: record },
        );
      } catch (err) {
        console.error("setup: the model failed", err);
        return add({ kind: "error", text: `Hatbot couldn't answer: ${modelErrorText(err)}.` });
      } finally {
        release();
      }
      record(res.model, res.usage);
      this.messages.push({
        role: "assistant",
        content: res.content as Anthropic.Beta.BetaContentBlockParam[],
      });
      this.container = containerOf(res, this.container);
      const said = res.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
        .trim();
      if (said) add({ kind: "bot", text: said });
      if (res.stop_reason === "pause_turn") continue;
      const calls = res.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (!calls.length) return;
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      let waits: Pending | null = null;
      for (const call of calls) {
        const out: Outcome = cutOff(res)
          ? { error: "Cut off at max_tokens. Do less in one go." }
          : waits
            ? { error: "Only one form or question at a time." }
            : await this.call(call, add);
        if ("waits" in out) {
          waits = { toolUseId: call.id, kind: out.waits, itemId: out.itemId, results: [] };
          continue;
        }
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: "error" in out ? out.error : out.text,
          ...("error" in out ? { is_error: true } : {}),
        });
      }
      if (waits) {
        waits.results = results;
        this.pending = waits;
        return;
      }
      if (serverToolWaiting(res.content)) continue;
      this.pushUser(results);
    }
    add({ kind: "error", text: "Hatbot stopped after too many steps. Write to it to go on." });
  }

  /** A failed turn leaves the owner's message unanswered: the next one joins it. */
  private pushUser(content: Anthropic.Beta.BetaContentBlockParam[]) {
    const last = this.messages.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push(...content);
    else this.messages.push({ role: "user", content });
  }

  private async call(
    call: Anthropic.Beta.BetaToolUseBlock,
    add: (item: SetupItem) => void,
  ): Promise<Outcome> {
    const tool = TOOLS.find((t) => t.name === call.name);
    if (!tool) return { error: `Unknown tool "${call.name}".` };
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) return { error: invalidInput(parsed.error) };
    try {
      return await this.do(call.name, parsed.data, add);
    } catch (err) {
      if (err instanceof UserError || err instanceof PluginError) return { error: err.message };
      console.error(`setup: ${call.name} failed`, err);
      return { error: "That failed; see the brain's log." };
    }
  }

  private async do(
    name: string,
    /** Parsed by the tool's schema. */
    input: unknown,
    add: (item: SetupItem) => void,
  ): Promise<Outcome> {
    const { plugins, bots, settings } = this.d;
    const change = (text: string) => add({ kind: "change", text });
    switch (name) {
      case "look":
        return { text: await this.look((input as z.infer<typeof Look>).what) };
      case "change_settings": {
        const patch = SettingsPatch.omit({ paused: true })
          .strict()
          .safeParse((input as z.infer<typeof ChangeSettings>).changes);
        if (!patch.success) return { error: invalidInput(patch.error) };
        const before = settings.get();
        const problem = modelProblem(patch.data, this.d.models.catalogue(), before);
        if (problem) return { error: `${problem.field}: ${problem.error}` };
        const after = settings.update(patch.data);
        this.d.events.emit({ type: "settings.updated", settings: after });
        const lines = settingsLines(before, after);
        for (const l of lines) change(l);
        return { text: lines.length ? `Changed:\n${lines.join("\n")}` : "Nothing changed." };
      }
      case "switch_plugin": {
        const { id, on } = input as z.infer<typeof SwitchPlugin>;
        const p = await plugins.update(id, { enabled: on });
        change(`Turned ${on ? "on" : "off"} ${p.name}`);
        return { text: `${p.name} is ${on ? stateText(p.state, p.message) : "off"}.` };
      }
      case "set_plugin": {
        const { id, config, values } = input as z.infer<typeof SetPlugin>;
        const p = plugins.get(id);
        if (!p) return { error: `No plugin "${id}".` };
        const secret = Object.keys(values ?? {}).find(
          (k) => p.env.find((e) => e.name === k)?.secret,
        );
        if (secret) return { error: `${secret} is secret: use ask_secrets.` };
        if (values && Object.keys(values).length) await plugins.setSecrets(id, values);
        if (config) await plugins.update(id, { config });
        const now = plugins.get(id) ?? p;
        change(`Changed ${p.name}'s settings`);
        return { text: `${p.name} is ${now.enabled ? stateText(now.state, now.message) : "off"}.` };
      }
      case "test_plugin":
        return { text: await this.test((input as z.infer<typeof PluginId>).id) };
      case "ask_secrets": {
        const { plugin, why } = input as z.infer<typeof AskSecrets>;
        const itemId = this.newId();
        if (plugin === "ntfy") {
          add({
            kind: "secrets",
            id: itemId,
            plugin,
            title: "ntfy",
            note: why,
            fields: NTFY_FIELDS,
            state: "open",
          });
          return { waits: "secrets", itemId };
        }
        const p = plugins.get(plugin);
        if (!p) return { error: `No plugin "${plugin}".` };
        if (p.named || !p.env.length)
          return { error: `${p.name}'s secrets are set on its page in Settings.` };
        add({
          kind: "secrets",
          id: itemId,
          plugin,
          title: p.name,
          note: why,
          fields: p.env.map((e) => ({
            name: e.name,
            hint: e.hint,
            optional: e.optional || e.set,
            secret: e.secret,
          })),
          state: "open",
        });
        return { waits: "secrets", itemId };
      }
      case "connect": {
        const { id } = input as z.infer<typeof PluginId>;
        const p = plugins.get(id);
        if (!p) return { error: `No plugin "${id}".` };
        if (!p.enabled) await plugins.update(id, { enabled: true });
        const res = (await plugins.action(id, "connect", {})) as { url?: string } | undefined;
        if (!res?.url) return { error: `${p.name} gave no address to connect at.` };
        const itemId = this.newId();
        add({
          kind: "connect",
          id: itemId,
          plugin: id,
          title: p.name,
          url: res.url,
          state: "open",
        });
        return { waits: "connect", itemId };
      }
      case "check_everything": {
        const report = await this.d.checks.run();
        return {
          text: report.results.map((r) => `${r.name}: ${r.state}. ${r.detail}`).join("\n"),
        };
      }
      case "make_bot": {
        const bot = bots.create(CreateBot.parse(input));
        this.d.chats.changed(this.d.chats.direct(bot.id).conversationId);
        change(`Made a bot: ${bot.name}`);
        return { text: `Made ${bot.name} (id ${bot.id}).` };
      }
      case "change_bot": {
        const { id, ...patch } = input as z.infer<typeof ChangeBot>;
        const was = bots.active(id);
        if (!was) return { error: `No bot "${id}".` };
        const bot = bots.update(id, patch);
        const what = Object.keys(patch).join(", ");
        change(`Changed ${was.name}: ${what}`);
        return { text: `Changed ${bot?.name ?? was.name}.` };
      }
      case "write_memory": {
        const { file, content } = input as z.infer<typeof WriteMemory>;
        await this.d.memory.write(file, content, settings.get().owner, `Setup: ${file}`);
        change(`Wrote ${file}`);
        return { text: "Written." };
      }
      case "topic": {
        const { topic, state } = input as z.infer<typeof Topic>;
        this.setTopic(topic, state);
        return { text: "Marked." };
      }
      case "ask": {
        const { question, choices } = input as z.infer<typeof Ask>;
        add({ kind: "bot", text: question, choices });
        return { waits: "ask" };
      }
    }
    return { error: `Unknown tool "${name}".` };
  }

  private async look(what: z.infer<typeof Look>["what"]): Promise<string> {
    const { plugins, bots, settings } = this.d;
    switch (what) {
      case "settings": {
        const { paused: _, ...s } = settings.get();
        return JSON.stringify(s, null, 1);
      }
      case "plugins":
        return plugins
          .list()
          .map((p) =>
            JSON.stringify({
              id: p.id,
              name: p.name,
              description: p.description,
              on: p.enabled,
              state: p.enabled ? stateText(p.state, p.message) : "off",
              values: p.env.map((e) => ({
                name: e.name,
                secret: e.secret,
                optional: e.optional,
                set: e.set,
                ...(e.secret ? {} : { value: e.value }),
              })),
              config: p.config,
              testable: p.testable,
              signsIn: p.env.some((e) => /set when you connect/i.test(e.hint ?? "")),
            }),
          )
          .join("\n");
      case "bots":
        return bots
          .list()
          .map((b) =>
            JSON.stringify({
              id: b.id,
              name: b.name,
              icon: b.icon,
              color: b.color,
              instructions: b.instructions,
              plugins: b.plugins,
            }),
          )
          .join("\n");
      case "memory": {
        const files = await Promise.all(
          MEMORY_FILES.map(
            async (f) => `<${f}>\n${(await this.d.memory.readOrNull(f)) ?? ""}\n</${f}>`,
          ),
        );
        return files.join("\n");
      }
      case "models":
        return this.d.models
          .catalogue()
          .map((m) =>
            JSON.stringify({
              id: m.id,
              provider: m.provider,
              computerUse: Boolean(m.capabilities.computerUse),
              price: m.price ? { input: m.price.input, output: m.price.output } : null,
            }),
          )
          .join("\n");
      case "topics":
        return JSON.stringify(this.topics());
    }
  }
}

const stateText = (state: string, message: string | null) =>
  state === "ready" ? "ready" : `${state.replace("_", " ")}${message ? `: ${message}` : ""}`;

/** One plain line for each value that changed, such as "limits.dailyUsd: 10 → 20". */
export function settingsLines(before: Settings, after: Settings): string[] {
  const flat = (v: unknown, at = ""): [string, unknown][] =>
    v && typeof v === "object" && !Array.isArray(v) && !(at === "safety.tools")
      ? Object.entries(v).flatMap(([k, x]) => flat(x, at ? `${at}.${k}` : k))
      : [[at, v]];
  const was = new Map(flat(before));
  const show = (v: unknown) =>
    typeof v === "boolean"
      ? v
        ? "on"
        : "off"
      : typeof v === "string"
        ? v || "none"
        : JSON.stringify(v);
  return flat(after)
    .filter(([k, v]) => JSON.stringify(was.get(k)) !== JSON.stringify(v))
    .map(([k, v]) => `${k}: ${show(was.get(k))} → ${show(v)}`);
}
