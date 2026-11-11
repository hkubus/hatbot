// Boxes: small web apps a bot makes for you, opened from the chat and kept.
import { z } from "zod";
import { type BoxFile, MAX_BOX_SECRET, SECRET_NAME } from "./hatbox";
import type { TaskStatus } from "./index";

export type Box = {
  id: number;
  /** The bot that made it; only it changes the box. */
  botId: string;
  conversationId: number | null;
  title: string;
  /** The version that opens. */
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BoxVersion = {
  n: number;
  title: string;
  createdAt: string;
  /** The reply that made it; null for one you made in the app. */
  messageId: number | null;
};

/** A secret the box's box.json declares, and whether you've set it: never its value. */
export type BoxSecret = { name: string; set: boolean };

export type BoxDetail = Box & {
  versions: BoxVersion[];
  secrets: BoxSecret[];
  actions: BoxActionInfo[];
};

/** A version's page, for its Code view. A box with files has them too, and its `html` is built from them. */
export type BoxPage = BoxVersion & { html: string; files?: BoxFile[] };

/** A box's page, in characters. */
export const MAX_BOX_HTML = 1_000_000;
/** What a box's page may keep with hatbox.store: each value, and all of them, as JSON, and a key. */
export const MAX_BOX_VALUE = 1024 * 1024;
export const MAX_BOX_STORE = 5 * 1024 * 1024;
export const MAX_BOX_KEY = 200;
/** What hatbox.ask sends Haiku, in characters, and the most it may answer, in tokens. */
export const MAX_BOX_ASK = 50_000;
export const MAX_BOX_ASK_SYSTEM = 10_000;
export const MAX_BOX_ASK_TOKENS = 8000;
/** A note hatbox.send puts in the chat, in characters. */
export const MAX_BOX_NOTE = 2000;
export const MAX_BOX_FEED_NAME = 40;
export const MAX_BOX_ACTION_NAME = 40;

export const OpenBox = z.object({
  version: z.number().int().positive().optional(),
  dark: z.boolean().optional(),
});

export const RevertBox = z.object({ version: z.number().int().positive() });

/** Secrets you set or (null) remove on a box's page, by name. */
export const SetBoxSecrets = z.object({
  values: z.record(z.string().regex(SECRET_NAME), z.string().min(1).max(MAX_BOX_SECRET).nullable()),
});

/** A call from a box's page, as the app passes it on. */
export const BoxCall = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), key: z.string().max(MAX_BOX_KEY) }),
  z.object({ op: z.literal("set"), key: z.string().min(1).max(MAX_BOX_KEY), value: z.unknown() }),
  z.object({ op: z.literal("delete"), key: z.string().max(MAX_BOX_KEY) }),
  z.object({ op: z.literal("keys") }),
  // hatbox.fetch: a request to the box's backend. A body that isn't UTF-8 text is base64.
  z.object({
    op: z.literal("fetch"),
    path: z.string().startsWith("/").max(2000),
    method: z
      .string()
      .regex(/^[A-Za-z]{1,10}$/)
      .optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().max(7_200_000).optional(),
    base64: z.boolean().optional(),
  }),
  // Haiku with no tools, a note in the box's chat, and a feed's latest result.
  z.object({
    op: z.literal("ask"),
    prompt: z.string().trim().min(1).max(MAX_BOX_ASK),
    system: z.string().max(MAX_BOX_ASK_SYSTEM).optional(),
    maxTokens: z.number().int().min(1).max(MAX_BOX_ASK_TOKENS).optional(),
  }),
  z.object({ op: z.literal("send"), text: z.string().trim().min(1).max(MAX_BOX_NOTE) }),
  // `fresh`: run the feed's tool first, when its last run is over a minute old.
  z.object({
    op: z.literal("feed"),
    name: z.string().max(MAX_BOX_FEED_NAME),
    fresh: z.literal(true).optional(),
  }),
  // hatbox.action: runs one of the bot's scripts that the bot let the page run; `check`: how its last
  // run went, without running it.
  z.object({
    op: z.literal("action"),
    name: z.string().max(MAX_BOX_ACTION_NAME),
    check: z.literal(true).optional(),
  }),
]);
export type BoxCall = z.infer<typeof BoxCall>;

/** The answer: `value` for get (absent when there's none), keys, and fetch (a BoxResponse). */
export type BoxAnswer = { value?: unknown };

/**
 * What hatbox.feed(name) gives the page: the feed's latest result (the tool's output, parsed when it's
 * JSON) and when it came; `error` says why its last run failed, or why it stopped.
 */
export type BoxFeedValue = { value: unknown; at: string; error?: string };

/** An action's run, as its task: what hatbox.action gives the page. */
export type BoxActionRun = { task: number; status: TaskStatus; summary?: string; at: string };

/** One of the bot's scripts, with a fixed input, that the box's page may run. */
export type BoxActionInfo = {
  name: string;
  script: string;
  input: Record<string, unknown>;
  last?: BoxActionRun;
};
