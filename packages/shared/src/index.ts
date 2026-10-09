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
  text: string;
  status: "streaming" | "done" | "error";
  createdAt: string;
};

/** Live events on /api/v1/stream. */
export type HatbotEvent =
  | { type: "message.created"; message: ThreadMessage }
  | { type: "message.delta"; id: number; text: string }
  | { type: "message.progress"; id: number; text: string }
  | { type: "message.done"; id: number; text: string; status: "done" | "error" }
  | { type: "spend.updated"; todayUsd: number; monthUsd: number }
  | { type: "memory.committed"; sha: string; message: string; author: string }
  | { type: "paused"; paused: boolean };

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
