import { z } from "zod";
import { BOT_ID } from "./bot-id";
import type { Box } from "./box";
import type { Negotiation } from "./negotiate";
import type { PluginInfo } from "./plugin";
import type { Schedule, Trigger } from "./schedule";
import type { Watcher } from "./watch";

export * from "./bot-id";
export * from "./box";
export * from "./chart";
export * from "./checks";
export * from "./negotiate";
export * from "./plugin";
export * from "./schedule";
export * from "./search";
export * from "./templates";
export * from "./thread";
export * from "./todo";
export * from "./watch";

export const API_PREFIX = "/api/v1";

export type Health = {
  ok: true;
  version: string;
};

export const SetupStart = z.object({ code: z.string().min(1) });
export type SetupStartResponse = { secret: string; uri: string };

export const SetupFinish = z.object({
  code: z.string().min(1),
  password: z.string().min(12).max(1024),
  totp: z.string().regex(/^\d{6}$/),
});

export const Login = z.object({
  password: z.string().min(1).max(1024),
  totp: z.string().regex(/^\d{6}$/),
  // "web" sets a session cookie. "app" returns a bearer token named after the device.
  client: z.enum(["web", "app"]).default("web"),
  device: z.string().min(1).max(100).optional(),
});

export const CreateToken = z.object({ name: z.string().min(1).max(100) });
export type ApiToken = { id: number; name: string; createdAt: string; lastUsedAt: string | null };
export type CreateTokenResponse = ApiToken & { token: string };

export type Me = { setupDone: boolean; authenticated: boolean };

export const ConfirmOwner = z.object({
  password: z.string().min(1).max(1024),
  totp: z.string().regex(/^\d{6}$/),
});
export const ChangePassword = ConfirmOwner.extend({ newPassword: z.string().min(12).max(1024) });
export const FinishTotpChange = z.object({ totp: z.string().regex(/^\d{6}$/) });
export type Session = {
  id: number;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};
/** How many other sessions and tokens a change signed out. */
export type SignedOutOthers = { ok: true; ended: number };

export const PostMessage = z
  .object({
    text: z.string().trim().max(100_000),
    attachmentIds: z.array(z.number().int().positive()).max(10).default([]),
    /** In the incognito conversation: it sees no history and is deleted when it ends. */
    incognito: z.boolean().default(false),
    /** The sender's own id: a resend with the same one (its answer was lost) is posted once. */
    clientId: z.string().min(1).max(64).optional(),
  })
  .refine((m) => m.text.length > 0 || m.attachmentIds.length > 0, {
    message: "A message needs text or a file.",
  });
export const SeenMessages = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) });
export const PutMemoryFile = z.object({
  content: z.string().max(1_000_000),
  message: z.string().max(200).optional(),
  /**
   * The `sha` GET /memory/file gave ("" for a new file). If the file has changed since, the write is
   * refused with 409 `{ error: "changed", sha, content }`: what it is now.
   */
  baseSha: z
    .string()
    .regex(/^([0-9a-f]{40})?$/)
    .optional(),
});

export type ThreadMessage = {
  id: number;
  role: "user" | "assistant";
  conversationId: number;
  /** The bot that wrote it; null for yours. */
  botId: string | null;
  /**
   * "task" and "schedule" messages are cards; their text is a plain-text fallback. "command": a command
   * you typed, or what came of it (one with a task shows the task like a reply does). "box": a note the
   * box `boxId` sent (hatbox.send, or its backend's scheduled() as a notification), shown as from the
   * box: neither yours nor the bot's words. "handoff": another bot (`botId`) handing this chat's bot
   * work (ask_bot); its text is the request, and `taskId` the hand-off.
   */
  kind: "text" | "task" | "schedule" | "command" | "box" | "handoff";
  text: string;
  status: "streaming" | "done" | "error";
  createdAt: string;
  taskId: number | null;
  scheduleId: number | null;
  negotiationId: number | null;
  /** The box this reply made or changed last shows under it. */
  boxId: number | null;
  /**
   * A hand-off's other end: on the request in the other bot's chat, the message that
   * asked; on that message, the request. Absent otherwise, and on a request a task asked for.
   */
  link?: MessageLink;
  /** The conversation it belongs to; cards from background tasks have none. */
  episodeId: number | null;
  /** When a task's result changed it after it was sent. */
  editedAt: string | null;
  /** When you last saw it. Hatbot's messages are unread while this is before they were sent or edited. */
  seenAt: string | null;
  attachments?: Attachment[];
  incognito?: true;
  /** The web pages it cites, in the order it first cites them. Absent when none. */
  sources?: Source[];
  /**
   * A reply that asks you something: the answers to tap, a list for each question it asks (empty for
   * an open one), sent as your message. Absent when it offers none.
   */
  choices?: string[][];
  /** While it's being written: what it has thought and done so far, a line each, the latest last. */
  progress?: string;
};

/** Progress text kept to its last `max` lines: what's shown of a reply or task at work. */
export function keepLines(text: string, max = 40): string {
  let at = text.length;
  for (let n = 0; n <= max && at > 0; n++) at = text.lastIndexOf("\n", at - 1);
  return at > 0 ? text.slice(at) : text;
}

export type MessageLink = { conversationId: number; messageId: number };

export type Source = { url: string; title: string };

/**
 * GET …/messages/changes: of the messages an app loaded from `from` up to `before`, the ids still
 * there, and the ones edited since `since`, whole. Earlier pages kept up to date after time away.
 */
export type MessageChanges = { ids: number[]; changed: ThreadMessage[] };

/** POST /thread/ask: your message, and the replies to it once they're done or the wait ran out. */
export type AskResult = { message: ThreadMessage; replies: ThreadMessage[]; finished: boolean };

/** A file in the chat. Its bytes are at GET /api/attachments/:id. */
export type Attachment = {
  id: number;
  name: string;
  mediaType: string;
  size: number;
  from: "owner" | "hatbot";
  createdAt: string;
  /** A task handed it to the bot in the chat (send_to_chat): data for its reply, not shown in the chat. */
  forChat?: true;
};

export type Episode = {
  id: number;
  startedAt: string;
  lastActivityAt: string;
  /** One or two sentences on what it was about; null until it has been idle for 30 minutes. */
  recap: string | null;
};

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_takeover"
  /** It asked you something (ask_owner) and waits for your answer. */
  | "waiting_answer"
  | "done"
  | "failed"
  | "cancelled";
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_takeover",
  "waiting_answer",
];

export type Task = {
  id: number;
  botId: string;
  /** The bot that handed it over with ask_bot; null when you or its own bot started it. */
  requestedBy: string | null;
  /** The chat it reports to: the one it was started from, or its bot's own. Null on older tasks. */
  conversationId: number | null;
  title: string;
  goal: string;
  successCriteria: string;
  origin: "chat" | "schedule" | "webhook" | "alert" | "watch" | "heartbeat";
  lane: "screen" | "background";
  /** The schedule or trigger that started it, by name. */
  source: string | null;
  scheduleId: number | null;
  triggerId: number | null;
  watcherId: number | null;
  /** The task that started this one (a desktop task run by a background task). */
  parentId: number | null;
  /** The event that started it, as received; untrusted unless its trigger is trusted. */
  payload: string | null;
  model: string;
  /** Desktop tasks: the skill (skills/<name>.md) it follows. */
  skill: string | null;
  /** Background tasks: null runs at the chat's effort. */
  effort: "low" | "medium" | "high" | null;
  /** It ends in a report, attached, as research does. */
  research: boolean;
  /** The plugin task runner it runs on, e.g. "research"; null for a task's own loop. */
  runner: string | null;
  reportPath: string | null;
  /** The to-do item it works on, ticked off when it ends done. */
  todo: string | null;
  status: TaskStatus;
  /** It has read untrusted content. */
  tainted: boolean;
  /** The first untrusted thing it read, or what started it tainted. Null before this was kept. */
  taintedBy: string | null;
  summary: string | null;
  costUsd: number;
  steps: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/**
 * A task as a chat's card or a list row shows it (`GET /tasks?view=card`): without its goal, criteria,
 * event and cost, which only its own page shows, from `GET /tasks/:id`.
 */
export type TaskCard = Omit<Task, "goal" | "successCriteria" | "payload" | "costUsd" | "steps">;
export const isFullTask = (t: Task | TaskCard): t is Task => "goal" in t;

export type TaskStep = {
  id: number;
  taskId: number;
  kind: "note" | "action" | "screenshot" | "page" | "approval" | "takeover" | "error" | "task";
  name: string;
  detail: string;
  /** Archive path of a screenshot; fetch it from /tasks/:id/screens/:stepId. */
  screenshot: string | null;
  /** A page's URL; for "task" steps, the task it started (/tasks/<id>). */
  url: string | null;
  createdAt: string;
};

/** A task's steps with only the model's latest note; your own notes on approvals stay. */
export function latestNoteOnly(steps: TaskStep[]): TaskStep[] {
  const isModelNote = (s: TaskStep) => s.kind === "note" && s.name === "Note";
  const last = steps.findLast(isModelNote);
  return steps.filter((s) => !isModelNote(s) || s === last);
}

export type ApprovalKind =
  | "send"
  | "submit_personal_data"
  | "purchase"
  | "payment"
  | "delete"
  | "account_security"
  /** Who can get into the house: a lock, the alarm, a door or gate, or a scene or group with one. */
  | "access"
  | "injection_warning"
  | "budget"
  /** A negotiation's mandate: what the bot may do on its own with one seller. */
  | "mandate"
  /** Posting a flip Scout marked ready on the marketplaces picked for it. */
  | "listing"
  | "other";

/** Where one channel of a flip Scout marked ready to list is. */
export type ListingStatus = "queued" | "posting" | "listed" | "failed" | "declined" | "cancelled";

/** How far an approval goes besides this once: `always`, this exact call for this bot from now on. */
export type ApprovalScope = "always";

/** The kinds Safety settings choose for; budget, mandates and injection warnings have their own. */
export const SAFETY_KINDS = [
  "send",
  "submit_personal_data",
  "delete",
  "other",
  "purchase",
  "payment",
  "account_security",
  "access",
] as const satisfies readonly ApprovalKind[];
export type SafetyKind = (typeof SAFETY_KINDS)[number];
/** Ask you; let the safety review answer first; or go ahead. */
export const APPROVAL_LEVELS = ["ask", "review", "allow"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

/** What asks you and what goes ahead. Refusals that keep the homelab and Hatbot itself whole stay. */
export type SafetySettings = {
  kinds: Record<SafetyKind, ApprovalLevel>;
  /** After reading untrusted content, changes ask first. */
  untrusted: boolean;
  /** By write tool: always ask you, or never ask. Tools not here do as their plugin says. */
  tools: Record<string, "ask" | "allow">;
  /** Commands one chat reply runs itself before the work has to go to a task. */
  chatCommands: number;
};

export type Approval = {
  id: number;
  botId: string;
  taskId: number | null;
  /** The chat that waits for it, when no task does. */
  conversationId: number | null;
  /** The conversation in that chat, for a plugin change it asks about. */
  episodeId: number | null;
  kind: ApprovalKind;
  summary: string;
  reason: string;
  /** Untrusted sources the task had read. */
  sources: string[];
  /** The step whose screenshot shows what's being approved. */
  screenshotStepId: number | null;
  /** `blocked`: the safety review stopped it, and you may still run it anyway. */
  status: "pending" | "blocked" | "approved" | "denied" | "expired" | "cancelled";
  decidedVia: "web" | "ntfy" | null;
  costUsd: number;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** What you told the task along with your decision: what to do instead, or how to go ahead. */
  note: string | null;
  /** How far approving it may go besides this once; none for money, accounts, doors or suspicions. */
  scopes: ApprovalScope[];
  /** How far you approved it, if further than this once. */
  scope: ApprovalScope | null;
  /** Ready answers: each approves it, with itself as the note. */
  answers: string[];
};
export const DecideApproval = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().trim().max(4000).optional(),
  scope: z.enum(["always"]).optional(),
});
/** Running what the safety review blocked: once, or `always` for this exact call. */
export const RunAnyway = z.object({ always: z.boolean().optional() });

/** An exact call you always allow (Settings → Safety). */
export type ApprovalRule = {
  id: number;
  botId: string;
  tool: string;
  summary: string;
  createdAt: string;
};
export const TokenDecision = z.object({
  decision: z.enum(["approve", "deny"]),
  exp: z.number().int(),
  sig: z.string().min(1).max(200),
});

export type Question = {
  id: number;
  botId: string;
  taskId: number;
  /** The chat the task was started from, if any, which shows it too. */
  conversationId: number | null;
  question: string;
  /** Answers to tap; you can always write your own. */
  choices: string[];
  /** Untrusted things the task had read when it asked: a page could have steered the question. */
  sources: string[];
  status: "pending" | "answered" | "expired" | "cancelled";
  answer: string | null;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
};
export const AnswerQuestion = z.object({ answer: z.string().trim().min(1).max(4000) });
/** A notification's answer button: which choice, signed for that question and choice. */
export const TokenAnswer = z.object({
  choice: z.number().int().min(0),
  exp: z.number().int(),
  sig: z.string().min(1).max(200),
});

/** At most this many choices, each at most this long: they're buttons. */
export const MAX_CHOICES = 4;
export const MAX_CHOICE_CHARS = 60;
export const MAX_QUESTIONS_AT_ONCE = 3;

export type DesktopState = {
  /** desktop-agent answers. */
  online: boolean;
  /** "hatbot": Hatbot may act; "owner": you have control (takeover). */
  control: "hatbot" | "owner";
  request: { taskId: number; reason: string } | null;
  activeTaskId: number | null;
  /** The bot whose task that is, and whose browser profile is open. */
  botId: string | null;
};

/**
 * What's live when the stream opens, sent as its first event: an app needn't ask for each of these.
 * Brains from before it send only `paused`.
 */
export type Snapshot = {
  paused: boolean;
  /** Brief (`Bot.brief`). */
  bots: Bot[];
  conversations: Conversation[];
  /** The pending ones. */
  approvals: Approval[];
  /** The pending ones. */
  questions: Question[];
  desktop: DesktopState;
  /** Each chat's newest UNREAD_PER_CHAT unread messages; `Conversation.unread` counts them all. */
  unread: number[];
};
/** Unread message ids the stream's snapshot sends per chat: a page's worth and more. */
export const UNREAD_PER_CHAT = 100;

export type HatbotEvent =
  | ({ type: "snapshot" } & Snapshot)
  | { type: "message.created"; message: ThreadMessage }
  /** `at`: where `text` starts in the reply, so text a client already has isn't added twice. */
  | { type: "message.delta"; id: number; text: string; at?: number }
  | { type: "message.progress"; id: number; text: string }
  | {
      type: "message.done";
      id: number;
      text: string;
      status: "done" | "error";
      sources?: Source[];
      choices?: string[][];
    }
  | { type: "message.task"; id: number; taskId: number }
  | { type: "message.link"; id: number; link: MessageLink }
  | { type: "message.negotiation"; id: number; negotiationId: number }
  | { type: "message.box"; id: number; boxId: number }
  | { type: "message.edited"; id: number; editedAt: string }
  /** The task shown under this reply ended: its bot is writing the reply again, to say what came of it. */
  | { type: "message.rewrite"; id: number }
  | { type: "message.attachment"; id: number; attachment: Attachment }
  /** You saw these messages (on any device). */
  | { type: "message.seen"; ids: number[]; seenAt: string }
  /** These messages are gone: the incognito conversation they were in ended. */
  | { type: "message.deleted"; ids: number[] }
  /** What the reply being written has used so far, across its model calls. */
  | { type: "message.usage"; id: number; tokens: number; costUsd: number }
  | { type: "spend.updated"; todayUsd: number; monthUsd: number }
  | { type: "memory.committed"; sha: string; message: string; author: string }
  | { type: "proposal.updated"; proposal: Proposal }
  | { type: "paused"; paused: boolean }
  | { type: "task.updated"; task: Task }
  | { type: "task.step"; step: TaskStep }
  | { type: "task.progress"; taskId: number; text: string }
  | { type: "approval.created"; approval: Approval }
  | { type: "approval.resolved"; approval: Approval }
  | { type: "question.created"; question: Question }
  | { type: "question.resolved"; question: Question }
  | { type: "desktop.state"; state: DesktopState }
  | { type: "schedule.updated"; schedule: Schedule }
  | { type: "schedule.deleted"; id: number }
  | { type: "trigger.updated"; trigger: Trigger }
  | { type: "trigger.deleted"; id: number }
  | { type: "watcher.updated"; watcher: Watcher }
  | { type: "watcher.deleted"; id: number }
  | { type: "negotiation.updated"; negotiation: Negotiation }
  | { type: "box.updated"; box: Box }
  | { type: "box.deleted"; id: number }
  | { type: "plugin.updated"; plugin: PluginInfo }
  | { type: "teach.updated"; session: TeachSession }
  | { type: "episode.updated"; episode: Episode }
  | { type: "bot.updated"; bot: Bot }
  | { type: "bot.deleted"; id: string }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "conversation.deleted"; id: number }
  /** After PUT /settings: clients refetch or take these. */
  | { type: "settings.updated"; settings: AppSettings }
  /** After each heartbeat run: clients refetch GET /heartbeat. */
  | { type: "heartbeat.updated" };

/** The chat's effort, in Settings and per bot. Haiku 5.5 and Opus 5.5 both take each of them. */
export const CHAT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The first bot. It can't be deleted, and /thread is its chat. */
export const HATBOT_ID = "hatbot";

/** The icons a bot can have. The web draws them; iOS maps them to SF Symbols. */
export const BOT_ICONS = [
  "hat",
  "sparkles",
  "brain",
  "code",
  "terminal",
  "server",
  "wrench",
  "shield",
  "globe",
  "house",
  "book",
  "pen",
  "chart",
  "mail",
  "cart",
  "cat",
  "heart",
] as const;
export type BotIcon = (typeof BOT_ICONS)[number];
/** The colours a bot can have: Apple's system colours, with Hatbot's amber first. */
export const BOT_COLORS = [
  "amber",
  "red",
  "pink",
  "purple",
  "indigo",
  "blue",
  "teal",
  "green",
  "gray",
] as const;
export type BotColor = (typeof BOT_COLORS)[number];

export type Bot = {
  id: string;
  name: string;
  icon: BotIcon;
  color: BotColor;
  instructions: string;
  /** Null: what Settings → Chat say. */
  chatModel: AppSettings["chatModel"] | null;
  chatEffort: AppSettings["chatEffort"] | null;
  /** The plugins it may use, by id; null: every plugin that's on. */
  plugins: string[] | null;
  createdAt: string;
  /** Only the first line of its role is in `instructions`, as lists send it; `GET /bots/:id` has all of it. */
  brief?: true;
};
const botFields = {
  name: z.string().trim().min(1).max(40),
  icon: z.enum(BOT_ICONS),
  color: z.enum(BOT_COLORS),
  instructions: z.string().trim().max(8000),
  chatModel: z.string().min(1).max(200).nullable(),
  chatEffort: z.enum(CHAT_EFFORTS).nullable(),
  plugins: z.array(z.string().min(1).max(40)).max(50).nullable(),
};
export const CreateBot = z.object({
  ...botFields,
  // Left out: a hat, in a colour no other bot has yet.
  icon: botFields.icon.optional(),
  color: botFields.color.optional(),
  instructions: botFields.instructions.default(""),
  chatModel: botFields.chatModel.default(null),
  chatEffort: botFields.chatEffort.default(null),
  plugins: botFields.plugins.default(null),
});
export const UpdateBot = z.object(botFields).partial();

/** Most bots in a group, besides you. */
export const MAX_GROUP_BOTS = 6;

export type Conversation = {
  id: number;
  kind: "direct" | "group";
  /** A group's name; null for a bot's own chat, which goes by the bot's. */
  title: string | null;
  botIds: string[];
  unread: number;
  lastMessageAt: string | null;
};
export const CreateGroup = z.object({
  title: z.string().trim().max(80).optional(),
  botIds: z.array(z.string().regex(BOT_ID)).min(2).max(MAX_GROUP_BOTS),
});
export const UpdateGroup = z
  .object({
    title: z.string().trim().max(80),
    botIds: z.array(z.string().regex(BOT_ID)).min(2).max(MAX_GROUP_BOTS),
  })
  .partial();

/** A skill's name: its file is skills/<name>.md. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Teach-by-showing: a recording of you doing a chore, then the skill drafted from it. */
export type TeachSession = {
  id: number;
  /** recording → drafting → draft → saved; failed can be drafted again. */
  status: "recording" | "drafting" | "draft" | "failed" | "saved" | "discarded";
  startedAt: string;
  stoppedAt: string | null;
  /** What you did while recording: clicks, keys, typing and scrolling. */
  steps: number;
  /** The suggested name, then the saved one. */
  name: string | null;
  draft: string | null;
  error: string | null;
};
export const SaveSkill = z.object({
  name: z.string().regex(SKILL_NAME, "Use lowercase letters, digits and dashes."),
  content: z.string().trim().min(1).max(100_000),
});

/** The Update button in Settings (infra/hatbot-update.sh). */
export type UpdateStatus = {
  state: "running" | "done" | "failed" | "current";
  step: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** Things to do by hand, e.g. host scripts that changed. */
  notes: string[];
};
export type UpdateInfo = {
  /**
   * Where updates come from; null until deploy.sh sets it up. `signed`: only commits signed by your key
   * are deployed (HATBOT_UPDATE_SIGNERS); absent from a brain-deploy.sh older than that.
   */
  source: { url: string; branch: string; signed?: boolean } | null;
  current: { sha?: string; subject?: string; deployedAt?: string } | null;
  status: UpdateStatus | null;
  /** Requested, and hatbot-update hasn't picked it up yet. */
  requested: boolean;
};

export type MemoryFile = { path: string; size: number };

/** A change to memory for you to look over: a tidy-up, a fix to a skill, or a held write. */
export type Proposal = {
  id: number;
  kind: "tidy" | "skill" | "write";
  title: string;
  reason: string;
  /** null before: a new file; null after: deleted. */
  changes: { path: string; before: string | null; after: string | null }[];
  skill: string | null;
  /** stale: memory changed since, so it can't be applied as it is. */
  status: "pending" | "applied" | "dismissed" | "stale";
  createdAt: string;
  resolvedAt: string | null;
};

/** A skill, and the tasks following it that failed or needed you since it last changed. */
export type SkillStatus = {
  name: string;
  description: string;
  runs: number;
  failed: number[];
  takeovers: number[];
};
export type Commit = {
  sha: string;
  author: string;
  date: string;
  message: string;
  files: string[];
};

export type Limits = {
  taskUsd: number;
  /** A research task's starting limit, and what each raise adds. */
  researchUsd: number;
  dailyUsd: number;
  monthlyUsd: number;
  /** The last of the daily and monthly limits, which only alerts and the heartbeat spend. */
  alertReserveUsd: number;
  /** What boxes may spend asking Haiku in a day (hatbox.ask); 0 stops them asking. */
  boxesUsd: number;
};
/** Spend over a stretch of time: dollars, and tokens of every kind (input, cache, output). */
export type SpendWindow = { usd: number; tokens: number };
export type SpendSummary = {
  todayUsd: number;
  monthUsd: number;
  limits: Limits;
  todayTokens: number;
  lastHour: SpendWindow;
  lastMinute: SpendWindow;
};
/** One hour of the last day; `hour` is when it starts (ISO). */
export type SpendHour = SpendWindow & { hour: string };
export type SpendDay = { date: string; usd: number };
export type SpendByModel = { model: string; usd: number };
/** GET /models: the models offered by the providers that are on, for Settings' pickers. */
export type ModelOption = { id: string; name: string; provider: string; computerUse: boolean };
/** GET /spend/by-purpose: what the money went on, the most first. */
export type SpendByPurpose = { purpose: string; costUsd: number };

/** Where a connection's settings come from: Settings, the host's /etc/hatbot (deploy.sh), or nowhere. */
export type ConnectionSource = "app" | "host" | null;
/** GET /connections: the ntfy server. The token never comes back. */
export type Connections = {
  ntfy: { url: string; topic: string; tokenSet: boolean; from: ConnectionSource };
};
/** PUT /connections/ntfy. A token left out stays as it is. */
export const SetNtfy = z.object({
  url: z
    .string()
    .trim()
    .max(200)
    .regex(
      /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/,
      "The server's address, like https://ntfy.example.com.",
    )
    .transform((u) => u.replace(/\/+$/, "")),
  topic: z
    .string()
    .trim()
    .regex(/^[-_A-Za-z0-9]{1,64}$/, "Letters, digits, - and _ only, up to 64."),
  token: z.string().trim().min(1).max(200).optional(),
});

export type AppSettings = {
  limits: Limits;
  chatEffort: (typeof CHAT_EFFORTS)[number];
  /** The chat's model; unless it's the expert model, it can ask the expert for hard parts. */
  chatModel: string;
  owner: { name: string; email: string };
  paused: boolean;
  /** Changes Haiku finds safe go ahead without asking. */
  reviewChanges: boolean;
  safety: SafetySettings;
  /** What tapping a notification opens: the web app, or the iOS app (hatbot:// links). */
  notificationsOpen: "web" | "app";
  /** It needs computer use. */
  desktopModel: string;
  /** A desktop task the desktop model fails at carries on once on the expert model. */
  desktopEscalate: boolean;
  /** The model background tasks (SSH, Proxmox, code work) run on. */
  taskModel: string;
  /** Quick jobs: checks, summaries, research helpers, approval reviews. */
  smallModel: string;
  /** Hard parts: what the chat asks for help with, memory proposals, teaching. */
  expertModel: string;
  heartbeat: HeartbeatSettings;
  /** A tidy-up of memory proposed weekly, at the weekly report's time. */
  memoryTidy: boolean;
  weeklyReport: WeeklyReportSettings;
  /** The local hour the to-do list's morning reminder goes out. */
  todoHour: number;
};

/**
 * Every few minutes Hatbot looks over what went wrong without the model (failed tasks, expired
 * approvals, watchers and plugins that can't be read, monitors down, backups failing, spend). Only
 * something new goes to Haiku, which tells you, starts a task, or lets it be.
 */
export type HeartbeatSettings = {
  enabled: boolean;
  everyMinutes: number;
  /** The bot whose chat hears it and that runs its tasks. */
  botId: string;
  /** What you want done, for Haiku's choice and the task it starts. */
  instructions: string;
};

/** A summary of the week, made without the model, in Hatbot's chat and as a notification. */
export type WeeklyReportSettings = {
  enabled: boolean;
  /** 0 is Sunday. */
  weekday: number;
  hour: number;
};

export type HeartbeatInfo = {
  at: string | null;
  found: string[];
  action: "nothing" | "notify" | "task" | null;
  note: string;
  taskId: number | null;
  /** The last 20 looks that found something, newest first. */
  recent: HeartbeatRun[];
};

export type HeartbeatRun = {
  at: string;
  found: string[];
  action: "nothing" | "notify" | "task";
  note: string;
  taskId: number | null;
};
