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
import { NotChanged, TOOLS, type ToolContext } from "./tools";

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
> & { t3Ready?: (bot: Offer["bot"]) => boolean };

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
const desktop = (_: Offer, s: CoreServices) => Boolean(s.desktop?.configured);
/** Boxes are code: with a code bot, it makes and changes them all. */
const noCoder = (o: Offer, s: CoreServices) => !s.bots?.coderFor(o.bot);
const box = (label: string, change = false): Meta => ({
  plugin: "boxes",
  label,
  places: CHAT,
  deferred: true,
  ...(change ? { when: noCoder } : {}),
});

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
    when: desktop,
  },
  run_task: { plugin: "tasks", label: "Starting a task", places: CHAT },
  research: { plugin: "tasks", label: "Starting research", places: CHAT },
  todo_work: { plugin: "tasks", label: "Starting a task on a to-do", places: CHAT },
  ask_bot: { plugin: "tasks", label: "Asking another bot", places: CHAT, when: withOthers },
  get_task: { plugin: "tasks", label: "Checking on a task", places: CHAT },
  steer_task: { plugin: "tasks", label: "Steering a task", places: CHAT },
  box_create: box("Making a box", true),
  box_edit: box("Changing a box", true),
  box_t3: {
    ...box("Handing the box to T3 Code", true),
    when: (o, s) => noCoder(o, s) && Boolean(s.t3Ready?.(o.bot)),
  },
  box_list: box("Looking at boxes"),
  box_read: box("Reading a box"),
  box_revert: box("Changing a box", true),
  box_data: box("Reading what a box saved"),
  box_look: box("Looking at a box"),
  box_feed: box("Giving a box a feed", true),
  box_logs: box("Reading a box's logs"),
  box_call: box("Trying a box's backend"),
};

const NAMES: Record<string, string> = {
  memory: "Memory",
  tasks: "Tasks",
  boxes: "Boxes",
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
  const s = services;
  return {
    name: def.name,
    description: def.description,
    schema: def.schema as z.ZodType,
    access: meta.access ?? "own",
    places: meta.places,
    incognito: meta.incognito,
    deferred: meta.deferred,
    when: meta.when && ((o) => meta.when?.(o, s()) ?? true),
    whole: true,
    label: meta.label,
    run: async (input, call) => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: each tool's run matches its own schema
        const out = await def.run(input as any, fromCall(s(), call), call.signal);
        return typeof out === "string" ? out : { text: out.text, images: [out.image] };
      } catch (err) {
        if (err instanceof UserError || err instanceof NotChanged || err instanceof SandboxError)
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
