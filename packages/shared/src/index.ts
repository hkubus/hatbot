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
