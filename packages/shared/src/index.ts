// API types shared by the brain, the web app and the future iOS app (PLAN.md §4.4).
import { z } from "zod";

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

export const PostMessage = z.object({ text: z.string().trim().min(1).max(100_000) });
export const PutMemoryFile = z.object({
  content: z.string().max(1_000_000),
  message: z.string().max(200).optional(),
});

export type ThreadMessage = {
  id: number;
  role: "user" | "assistant";
  /** "task" and "approval" messages are cards; their text is a plain-text fallback. */
  kind: "text" | "task" | "approval";
  text: string;
  status: "streaming" | "done" | "error";
  createdAt: string;
  taskId: number | null;
  approvalId: number | null;
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
  title: string;
  goal: string;
  successCriteria: string;
  origin: "chat" | "schedule" | "webhook" | "alert";
  lane: "screen" | "background";
  model: string;
  status: TaskStatus;
  /** It has read untrusted content (PLAN.md §6.1). */
  tainted: boolean;
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
  kind: "note" | "action" | "screenshot" | "page" | "approval" | "takeover" | "error";
  /** Action name, or a short label. */
  name: string;
  detail: string;
  /** Archive path of a screenshot; fetch it from /tasks/:id/screens/:stepId. */
  screenshot: string | null;
  url: string | null;
  createdAt: string;
};

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
  taskId: number | null;
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
};
export const DecideApproval = z.object({ decision: z.enum(["approve", "deny"]) });
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
};

/** Live events on /api/v1/stream. */
export type HatbotEvent =
  | { type: "message.created"; message: ThreadMessage }
  | { type: "message.delta"; id: number; text: string }
  | { type: "message.progress"; id: number; text: string }
  | { type: "message.done"; id: number; text: string; status: "done" | "error" }
  | { type: "spend.updated"; todayUsd: number; monthUsd: number }
  | { type: "memory.committed"; sha: string; message: string; author: string }
  | { type: "paused"; paused: boolean }
  | { type: "task.updated"; task: Task }
  | { type: "task.step"; step: TaskStep }
  | { type: "task.progress"; taskId: number; text: string }
  | { type: "approval.created"; approval: Approval }
  | { type: "approval.resolved"; approval: Approval }
  | { type: "desktop.state"; state: DesktopState };

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
export type Commit = {
  sha: string;
  author: string;
  date: string;
  message: string;
  files: string[];
};

export type Limits = { taskUsd: number; dailyUsd: number; monthlyUsd: number };
export type SpendSummary = { todayUsd: number; monthUsd: number; limits: Limits };
export type SpendDay = { date: string; usd: number };
export type SpendByModel = { model: string; usd: number };

export type AppSettings = {
  limits: Limits;
  chatEffort: "low" | "medium" | "high";
  owner: { name: string; email: string };
  paused: boolean;
};
