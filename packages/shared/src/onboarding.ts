// The guided setup: a form for the model provider, then the bot interviews the owner topic by topic.
import { z } from "zod";

export const SETUP_TOPICS = [
  "you",
  "bots",
  "plugins",
  "notifications",
  "safety",
  "heartbeat",
] as const;
export type SetupTopic = (typeof SETUP_TOPICS)[number];

export const SETUP_TOPIC_NAMES: Record<SetupTopic, string> = {
  you: "You",
  bots: "Bots",
  plugins: "Plugins and connections",
  notifications: "Notifications",
  safety: "Safety and spending",
  heartbeat: "Heartbeat",
};

export type SetupTopicState = "todo" | "done" | "skipped";

export type SetupField = { name: string; hint: string | null; optional: boolean; secret: boolean };

/** What the setup screen shows, in order. A form's or button's `id` answers it. */
export type SetupItem =
  | { kind: "owner"; text: string }
  | { kind: "bot"; text: string; choices?: string[] }
  | { kind: "change"; text: string }
  | {
      kind: "secrets";
      id: string;
      /** A plugin's id, or "ntfy". */
      plugin: string;
      title: string;
      /** What it's for and where to find it, in the bot's words. */
      note: string;
      fields: SetupField[];
      state: "open" | "saved" | "skipped";
    }
  | {
      kind: "connect";
      id: string;
      plugin: string;
      title: string;
      url: string;
      state: "open" | "done" | "skipped";
    }
  | { kind: "error"; text: string };

export type Onboarding = {
  finished: boolean;
  /** No model provider works yet: the Models form comes first. */
  needsModels: boolean;
  topics: Record<SetupTopic, SetupTopicState>;
  items: SetupItem[];
  /** The bot is answering. */
  busy: boolean;
};

export const SETUP_PROVIDERS = ["anthropic", "openai"] as const;

export const SetupModels = z.object({
  provider: z.enum(SETUP_PROVIDERS),
  key: z.string().trim().min(1).max(1000),
  baseUrl: z.url().max(300).optional(),
});

const Id = z.string().min(1).max(40);

export const SetupTurn = z.union([
  /** The interview's first turn: the bot speaks first. */
  z.strictObject({ start: z.strictObject({ timezone: z.string().max(64) }) }),
  z.strictObject({ say: z.string().trim().min(1).max(8000) }),
  z.strictObject({ skip: z.enum(SETUP_TOPICS) }),
  /** null: skipped. */
  z.strictObject({
    secrets: z.strictObject({
      id: Id,
      values: z.record(z.string().max(100), z.string().max(4000)).nullable(),
    }),
  }),
  z.strictObject({
    connected: z.strictObject({ id: Id, error: z.string().max(500).optional() }),
  }),
]);
export type SetupTurn = z.infer<typeof SetupTurn>;

/** A turn streams as lines of these, the last a `state`. */
export type SetupEvent =
  | { type: "text"; text: string }
  | { type: "item"; item: SetupItem }
  | { type: "state"; onboarding: Onboarding };
