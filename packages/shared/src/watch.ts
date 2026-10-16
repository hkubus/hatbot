// Watchers: look at a page or a plugin's value on a timer, without the model, and wake a bot only
// when it changes the way you asked.
import { z } from "zod";

/** Where the value comes from, and how it's picked out. */
export type WatchSource = {
  /** page: fetched from the desktop, which can only reach the internet. tool: a plugin's read tool. */
  kind: "page" | "tool";
  /** page: the address. */
  url?: string;
  /**
   * page: loaded in a headless Chromium on the desktop, so what its scripts write is there. Slower and
   * heavier than a plain fetch: such a watcher looks every MIN_RENDER_WATCH_MINUTES at most.
   */
  render?: boolean;
  /** tool: its name, e.g. forgejo_pull, and what it's called with. */
  tool?: string;
  input?: Record<string, unknown>;
  /** page: the text of the elements this CSS selector matches. Without one, the page's text. */
  selector?: string;
  /** JSON (an API, or a tool's output): the value at this path, e.g. "items.0.price". */
  path?: string;
  /** A regular expression over the text: its first group, or the whole match. */
  pattern?: string;
};

/** When a new value counts. Only a change into the condition counts, not every check while it holds. */
export type WatchCondition =
  | { when: "changed" }
  | { when: "contains" | "missing"; text: string }
  | { when: "below" | "above"; value: number };

export type Watcher = {
  id: number;
  /** The bot told, or whose task runs. */
  botId: string;
  name: string;
  source: WatchSource;
  condition: WatchCondition;
  /** What the bot does when it counts, as a background task. Empty: you're only told. */
  prompt: string;
  everyMinutes: number;
  /** Switches itself off after the first time it counts. */
  once: boolean;
  enabled: boolean;
  createdVia: "chat" | "owner";
  /** The chat made or changed it after reading untrusted content, so its tasks start tainted. */
  tainted: boolean;
  taintedBy: string | null;
  createdAt: string;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  /** What it saw last; null before the first check. */
  lastValue: string | null;
  lastChangedAt: string | null;
  lastFiredAt: string | null;
  /** Why the last check failed; null when it worked. */
  lastError: string | null;
  /** Failed checks in a row. */
  errors: number;
  lastTaskId: number | null;
};

/** A value that differed from the one before, and whether it counted. */
export type WatcherValue = { id: number; value: string; fired: boolean; createdAt: string };

/** What a check found, without saving anything: for the form's Try button. */
export type WatchPreview = { ok: true; value: string } | { ok: false; error: string };

/** Watchers look at most this often, in minutes. */
export const MIN_WATCH_MINUTES = 5;
/** Watchers that run a page's scripts look at most this often: each look is a Chromium on the desktop. */
export const MIN_RENDER_WATCH_MINUTES = 15;

/** How often a watcher on this source may look, at most, in minutes. */
export const minWatchMinutes = (s: Pick<WatchSource, "kind" | "render">) =>
  s.kind === "page" && s.render ? MIN_RENDER_WATCH_MINUTES : MIN_WATCH_MINUTES;

export const WatchSourceInput = z
  .object({
    kind: z.enum(["page", "tool"]),
    url: z.string().trim().url().max(2000).optional(),
    render: z.boolean().optional(),
    tool: z.string().trim().min(1).max(64).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    selector: z.string().trim().min(1).max(300).optional(),
    path: z.string().trim().min(1).max(200).optional(),
    pattern: z.string().min(1).max(300).optional(),
  })
  .refine((s) => (s.kind === "page" ? Boolean(s.url) : Boolean(s.tool)), {
    message: "A page needs a url; a tool needs its name.",
  });

export const WatchConditionInput = z.discriminatedUnion("when", [
  z.object({ when: z.literal("changed") }),
  z.object({ when: z.enum(["contains", "missing"]), text: z.string().min(1).max(200) }),
  z.object({ when: z.enum(["below", "above"]), value: z.number().finite() }),
]);

const fields = {
  name: z.string().trim().min(1).max(80),
  source: WatchSourceInput,
  condition: WatchConditionInput,
  prompt: z.string().trim().max(4000),
  everyMinutes: z
    .number()
    .int()
    .min(MIN_WATCH_MINUTES)
    .max(7 * 24 * 60),
  once: z.boolean(),
  enabled: z.boolean(),
  botId: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
};

export const CreateWatcher = z.object({
  ...fields,
  condition: fields.condition.default({ when: "changed" }),
  prompt: fields.prompt.default(""),
  everyMinutes: fields.everyMinutes.default(60),
  once: fields.once.default(false),
  enabled: fields.enabled.default(true),
  botId: fields.botId.default("hatbot"),
});
export const UpdateWatcher = z.object(fields).partial();

/** "Every hour", "Every 15 minutes", "Every 2 days". */
export function describeEvery(minutes: number): string {
  const unit = (n: number, word: string) => (n === 1 ? `Every ${word}` : `Every ${n} ${word}s`);
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

/** "Changes", "Contains “In stock”", "Below 1000". */
export function describeCondition(c: WatchCondition): string {
  switch (c.when) {
    case "changed":
      return "Changes";
    case "contains":
      return `Contains “${c.text}”`;
    case "missing":
      return `Doesn't contain “${c.text}”`;
    case "below":
      return `Below ${c.value}`;
    case "above":
      return `Above ${c.value}`;
  }
}
