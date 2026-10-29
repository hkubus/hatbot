// The core's own tools, offered and run as internal plugins' are: one way for every tool.
import {
  type CallContext,
  definePlugin,
  type Offer,
  type Place,
  type Plugin,
  PluginError,
  type PluginTool,
  ready,
  SandboxError,
} from "@hatbot/plugin-sdk";
import { z } from "zod";
import { UserError } from "../errors";
import { TOOLS, type ToolContext } from "./tools";

/** What the core's tools reach, besides what each call brings. */
export type CoreServices = Omit<
  ToolContext,
  | "bot"
  | "conversationId"
  | "messageId"
  | "episodeId"
  | "taskId"
  | "tainted"
  | "taint"
  | "suspected"
  | "ownerSaid"
  | "answering"
  | "approve"
>;

type Meta = {
  plugin: string;
  label: string;
  access?: "read" | "own";
  places?: Place[];
  incognito?: boolean;
  deferred?: boolean;
  when?: (o: Offer, s: CoreServices) => boolean;
};

const CHAT: Place[] = ["chat"];
const WORK: Place[] = ["chat", "task"];
const ALL: Place[] = ["chat", "task", "research"];
const withOthers = (o: Offer) => o.others.length > 0;
const mainChat = (o: Offer) => o.chat === "direct";
const inThread = (o: Offer) => o.chat === "thread";
const desktop = (_: Offer, s: CoreServices) => Boolean(s.desktop?.configured);
const screen = (_: Offer, s: CoreServices) => Boolean(s.tasks?.hasScreen());
const META: Record<string, Meta> = {
  memory_list: { plugin: "memory", label: "Looking through memory", access: "read", places: ALL },
  memory_read: { plugin: "memory", label: "Reading memory", access: "read", places: ALL },
  memory_search: { plugin: "memory", label: "Searching memory", access: "read", places: ALL },
  memory_write: { plugin: "memory", label: "Saving to memory", places: ALL },
  memory_delete: { plugin: "memory", label: "Removing from memory", places: WORK },
  todo_list: { plugin: "memory", label: "Looking at the to-do list", access: "read", places: WORK },
  todo_add: { plugin: "memory", label: "Adding a to-do", places: WORK },
  todo_done: { plugin: "memory", label: "Ticking off a to-do", places: WORK },
  search_history: {
    plugin: "memory",
    label: "Searching earlier messages",
    access: "read",
    places: WORK,
    incognito: false,
  },
  send_file: { plugin: "tasks", label: "Sending a file", places: WORK, when: desktop },
  run_desktop_task: {
    plugin: "tasks",
    label: "Starting a desktop task",
    places: CHAT,
    deferred: true,
    when: screen,
  },
  run_task: { plugin: "tasks", label: "Starting a task", places: CHAT },
  todo_work: { plugin: "tasks", label: "Starting a task on a to-do", places: CHAT },
  ask_bot: { plugin: "tasks", label: "Asking another bot", places: CHAT, when: withOthers },
  get_task: { plugin: "tasks", label: "Checking on a task", places: CHAT },
  steer_task: { plugin: "tasks", label: "Steering a task", places: CHAT },
  thread_open: { plugin: "threads", label: "Opening a thread", places: CHAT, when: mainChat },
  thread_read: {
    plugin: "threads",
    label: "Reading a thread",
    access: "read",
    places: CHAT,
    incognito: false,
    when: mainChat,
  },
  thread_resolve: {
    plugin: "threads",
    label: "Resolving the thread",
    places: CHAT,
    when: inThread,
  },
};

const NAMES: Record<string, string> = {
  memory: "Memory",
  tasks: "Tasks",
  threads: "Threads",
};

/** A call's own part of what a core tool sees; its requests to the desktop end with the call. */
const fromCall = (s: CoreServices, call: CallContext): ToolContext => ({
  ...s,
  desktop: s.desktop?.withSignal?.(call.signal) ?? s.desktop,
  bot: call.bot,
  conversationId: call.conversationId,
  messageId: call.messageId,
  episodeId: call.episodeId,
  taskId: call.task?.id,
  tainted: call.tainted,
  taint: call.taint,
  suspected: call.suspected,
  ownerSaid: call.ownerSaid,
  answering: call.answering,
  approve: call.approve,
});

function coreTool(def: (typeof TOOLS)[number], services: () => CoreServices): PluginTool {
  const meta = META[def.name];
  if (!meta) throw new Error(`core tool ${def.name} has no place`);
  return {
    name: def.name,
    description: def.description,
    schema: def.schema as z.ZodType,
    access: meta.access ?? "own",
    places: meta.places,
    incognito: meta.incognito,
    deferred: meta.deferred,
    when: meta.when && ((o) => meta.when?.(o, services()) ?? true),
    whole: true,
    label: meta.label,
    run: async (input, call) => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: each tool's run matches its own schema
        const out = await def.run(input as any, fromCall(services(), call), call.signal);
        return typeof out === "string" ? out : { text: out.text, images: [out.image] };
      } catch (err) {
        if (err instanceof UserError || err instanceof SandboxError)
          throw new PluginError((err as Error).message);
        throw err;
      }
    },
  };
}

/** The core's tools as internal plugins, grouped by what they're part of; `services` once all exist. */
export function corePlugins(services: () => CoreServices): Plugin[] {
  const groups = new Map<string, PluginTool[]>();
  for (const def of TOOLS) {
    const meta = META[def.name];
    if (!meta) throw new Error(`core tool ${def.name} has no place`);
    const list = groups.get(meta.plugin) ?? [];
    list.push(coreTool(def, services));
    groups.set(meta.plugin, list);
  }
  return [...groups].map(([id, tools]) =>
    definePlugin({
      id,
      name: NAMES[id] ?? id,
      description: "",
      internal: true,
      config: z.object({}),
      start: () => ready(tools),
    }),
  );
}
