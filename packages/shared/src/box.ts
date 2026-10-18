// Boxes (PLAN.md §21): small web apps a bot makes for you, opened from the chat and kept.
import { z } from "zod";

export type Box = {
  id: number;
  /** The bot that made it; only it changes the box. */
  botId: string;
  /** The chat it was made in. */
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

export type BoxDetail = Box & { versions: BoxVersion[] };

/** A version's page, for its Code view. */
export type BoxPage = BoxVersion & { html: string };

/** A box's page, in characters. */
export const MAX_BOX_HTML = 1_000_000;
/** What a box's page may keep with hatbox.store: each value, and all of them, as JSON, and a key. */
export const MAX_BOX_VALUE = 1024 * 1024;
export const MAX_BOX_STORE = 5 * 1024 * 1024;
export const MAX_BOX_KEY = 200;
/** What hatbox.ask sends Haiku, in characters, and the most it may answer, in tokens (X4). */
export const MAX_BOX_ASK = 50_000;
export const MAX_BOX_ASK_SYSTEM = 10_000;
export const MAX_BOX_ASK_TOKENS = 8000;

export const OpenBox = z.object({
  version: z.number().int().positive().optional(),
  dark: z.boolean().optional(),
});

export const RevertBox = z.object({ version: z.number().int().positive() });

/** A call from a box's page, as the app passes it on (PLAN.md §21.2). */
export const BoxCall = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), key: z.string().max(MAX_BOX_KEY) }),
  z.object({ op: z.literal("set"), key: z.string().min(1).max(MAX_BOX_KEY), value: z.unknown() }),
  z.object({ op: z.literal("delete"), key: z.string().max(MAX_BOX_KEY) }),
  z.object({ op: z.literal("keys") }),
  // X4: Haiku with no tools.
  z.object({
    op: z.literal("ask"),
    prompt: z.string().trim().min(1).max(MAX_BOX_ASK),
    system: z.string().max(MAX_BOX_ASK_SYSTEM).optional(),
    maxTokens: z.number().int().min(1).max(MAX_BOX_ASK_TOKENS).optional(),
  }),
]);
export type BoxCall = z.infer<typeof BoxCall>;

/** The answer: `value` for get (absent when there's none) and keys. */
export type BoxAnswer = { value?: unknown };
