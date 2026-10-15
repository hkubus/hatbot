// API types shared by the brain, the web app and the future iOS app (PLAN.md §4.4).
import { z } from "zod";
import type { PluginInfo } from "./plugin";
import type { Schedule, Trigger } from "./schedule";
import type { Watcher } from "./watch";

export * from "./chart";
export * from "./checks";
export * from "./plugin";
export * from "./schedule";
export * from "./search";
export * from "./thread";
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
export type LoginResponse = { ok: true; token?: string };

export const CreateToken = z.object({ name: z.string().min(1).max(100) });
export type ApiToken = { id: number; name: string; createdAt: string; lastUsedAt: string | null };
export type CreateTokenResponse = ApiToken & { token: string };

export type Me = { setupDone: boolean; authenticated: boolean };

export type ApiError = { error: string };

export const PostMessage = z
  .object({
    text: z.string().trim().max(100_000),
    /** Files uploaded first with POST /api/attachments. */
    attachmentIds: z.array(z.number().int().positive()).max(10).default([]),
    /** In the incognito conversation: it sees no history and is deleted when it ends. */
    incognito: z.boolean().default(false),
  })
  .refine((m) => m.text.length > 0 || m.attachmentIds.length > 0, {
    message: "A message needs text or a file.",
  });
export const SeenMessages = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) });
export const PutMemoryFile = z.object({
  content: z.string().max(1_000_000),
  message: z.string().max(200).optional(),
});

export type ThreadMessage = {
  id: number;
  role: "user" | "assistant";
  /** The conversation it's in: a bot's own chat, or a group. */
  conversationId: number;
  /** The bot that wrote it; null for yours. */
  botId: string | null;
  /**
   * "task" and "schedule" messages are cards; their text is a plain-text fallback. "command": a command
   * you typed, or what came of it (one with a task shows the task like a reply does).
   */
  kind: "text" | "task" | "schedule" | "command";
  text: string;
  status: "streaming" | "done" | "error";
  createdAt: string;
  taskId: number | null;
  scheduleId: number | null;
  /** The conversation it belongs to; cards from background tasks have none. */
  episodeId: number | null;
  /** When a task's result changed it after it was sent. */
  editedAt: string | null;
  /** When you last saw it. Hatbot's messages are unread while this is before they were sent or edited. */
  seenAt: string | null;
  /** Files sent with it: yours, or ones Hatbot (or the task under it) sent you. Absent when none. */
  attachments?: Attachment[];
  /** In the incognito conversation, which isn't kept. Absent otherwise. */
  incognito?: true;
};

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

/** A conversation in the thread (PLAN.md §5.3). Finished ones fold up under their recap. */
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
  | "done"
  | "failed"
  | "cancelled";
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_takeover",
];

export type Task = {
  id: number;
  /** The bot doing it: its prompt, plugins and browser profile. */
  botId: string;
  /** The bot that handed it over with ask_bot; null when you or its own bot started it. */
  requestedBy: string | null;
  title: string;
  goal: string;
  successCriteria: string;
  origin: "chat" | "schedule" | "webhook" | "alert" | "watch" | "heartbeat";
  lane: "screen" | "background";
  /** The schedule or trigger that started it, by name. */
  source: string | null;
  scheduleId: number | null;
  triggerId: number | null;
  /** The watcher whose change started it. */
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
  status: TaskStatus;
  /** It has read untrusted content (PLAN.md §6.1). */
  tainted: boolean;
  /** The first untrusted thing it read, or what started it tainted. Null before this was kept. */
  taintedBy: string | null;
  injectionSuspected: boolean;
  summary: string | null;
  costUsd: number;
  steps: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TaskStep = {
  id: number;
  taskId: number;
  kind: "note" | "action" | "screenshot" | "page" | "approval" | "takeover" | "error" | "task";
  /** Action name, or a short label. */
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
  const isModelNote = (s: TaskStep) => s.kind === "note" && s.name !== "Your note";
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
  | "injection_warning"
  | "budget"
  | "other";

export type Approval = {
  id: number;
  /** The bot asking. */
  botId: string;
  taskId: number | null;
  /** The chat that waits for it, when no task does. */
  conversationId: number | null;
  kind: ApprovalKind;
  summary: string;
  reason: string;
  /** Untrusted sources the task had read (PLAN.md §6.2). */
  sources: string[];
  /** The step whose screenshot shows what's being approved. */
  screenshotStepId: number | null;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  decidedVia: "web" | "ntfy" | null;
  costUsd: number;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** What you told the task along with your decision: what to do instead, or how to go ahead. */
  note: string | null;
};
export const DecideApproval = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().trim().max(4000).optional(),
});
export const TokenDecision = z.object({
  decision: z.enum(["approve", "deny"]),
  exp: z.number().int(),
  sig: z.string().min(1).max(200),
});

export type DesktopState = {
  /** desktop-agent answers. */
  online: boolean;
  /** "hatbot": Hatbot may act; "owner": you have control (takeover). */
  control: "hatbot" | "owner";
  /** A task waiting for you to take over, and why. */
  request: { taskId: number; reason: string } | null;
  /** The task using the screen. */
  activeTaskId: number | null;
  /** The bot whose task that is, and whose browser profile is open. */
  botId: string | null;
};

/** Live events on /api/v1/stream. */
export type HatbotEvent =
  | { type: "message.created"; message: ThreadMessage }
  | { type: "message.delta"; id: number; text: string }
  | { type: "message.progress"; id: number; text: string }
  | { type: "message.done"; id: number; text: string; status: "done" | "error" }
  /** A task now shows under this reply. */
  | { type: "message.task"; id: number; taskId: number }
  /** A task's result changed this message. */
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
  | { type: "desktop.state"; state: DesktopState }
  | { type: "schedule.updated"; schedule: Schedule }
  | { type: "schedule.deleted"; id: number }
  | { type: "trigger.updated"; trigger: Trigger }
  | { type: "trigger.deleted"; id: number }
  | { type: "watcher.updated"; watcher: Watcher }
  | { type: "watcher.deleted"; id: number }
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

/** The first bot. It can't be deleted, and /thread is its chat. */
export const HATBOT_ID = "hatbot";
/** A bot's id: made from its first name, and fixed after that. */
export const BOT_ID = /^[a-z][a-z0-9-]{0,30}$/;

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

/** One of your bots (PLAN.md §14): its own role, chat, memory folder, plugins and browser profile. */
export type Bot = {
  id: string;
  name: string;
  icon: BotIcon;
  color: BotColor;
  /** Its role, in your words. */
  instructions: string;
  /** Null: what Settings → Chat say. */
  chatModel: AppSettings["chatModel"] | null;
  chatEffort: AppSettings["chatEffort"] | null;
  /** The plugins it may use, by id; null: every plugin that's on. */
  plugins: string[] | null;
  createdAt: string;
};
const botFields = {
  name: z.string().trim().min(1).max(40),
  icon: z.enum(BOT_ICONS),
  color: z.enum(BOT_COLORS),
  instructions: z.string().trim().max(8000),
  chatModel: z.enum(["claude-haiku-5-5", "claude-opus-5-5"]).nullable(),
  chatEffort: z.enum(["low", "medium"]).nullable(),
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

/** A chat: one bot's own, or a group of bots and you. */
export type Conversation = {
  id: number;
  kind: "direct" | "group";
  /** A group's name; null for a bot's own chat, which goes by the bot's. */
  title: string | null;
  botIds: string[];
  /** Messages from its bots you haven't seen. */
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

/** Teach-by-showing (PLAN.md §1): a recording of you doing a chore, then the skill drafted from it. */
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
  /** The drafted skill, markdown. */
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
  /** Where updates come from; null until deploy.sh sets it up. */
  source: { url: string; branch: string } | null;
  /** The running release. */
  current: { sha?: string; subject?: string; deployedAt?: string } | null;
  /** The last or current update. */
  status: UpdateStatus | null;
  /** Requested, and hatbot-update hasn't picked it up yet. */
  requested: boolean;
};

export type MemoryFile = { path: string; size: number };

/** A change to memory for you to look over: a tidy-up, or a fix to a skill. */
export type Proposal = {
  id: number;
  kind: "tidy" | "skill";
  title: string;
  reason: string;
  /** null before: a new file; null after: deleted. */
  changes: { path: string; before: string | null; after: string | null }[];
  /** For a skill fix, the skill's name. */
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
  /** Tasks since the skill last changed. */
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

export type Limits = { taskUsd: number; dailyUsd: number; monthlyUsd: number };
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

export type AppSettings = {
  limits: Limits;
  chatEffort: "low" | "medium";
  /** The chat's model; on Haiku 5.5 it can ask Opus 5.5 for hard parts. */
  chatModel: "claude-haiku-5-5" | "claude-opus-5-5";
  owner: { name: string; email: string };
  paused: boolean;
  /** Changes Haiku finds safe go ahead without asking. */
  reviewChanges: boolean;
  /** What tapping a notification opens: the web app, or the iOS app (hatbot:// links). */
  notificationsOpen: "web" | "app";
  /** The model that drives desktop tasks. */
  desktopModel: "claude-opus-5-5" | "claude-haiku-5-5";
  /** The model background tasks (SSH, Proxmox, code work) run on. */
  taskModel: "claude-haiku-5-5" | "claude-opus-5-5";
  heartbeat: HeartbeatSettings;
  /** A tidy-up of memory proposed weekly, at the weekly report's time. */
  memoryTidy: boolean;
  weeklyReport: WeeklyReportSettings;
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

/** The heartbeat's last look, for Settings. */
export type HeartbeatInfo = {
  at: string | null;
  /** The new things it found. */
  found: string[];
  action: "nothing" | "notify" | "task" | null;
  note: string;
  taskId: number | null;
};
