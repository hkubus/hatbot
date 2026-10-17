import type { HatbotEvent } from "@hatbot/shared";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { principalOf } from "../auth/middleware";
import type { AppEnv } from "../context";

/** Streamed text that comes faster than this goes out together. */
const BATCH_MS = 50;

type Text = Extract<HatbotEvent, { type: "message.delta" | "message.progress" | "task.progress" }>;

const textKey = (e: HatbotEvent) =>
  e.type === "message.delta" || e.type === "message.progress"
    ? `${e.type} ${e.id}`
    : e.type === "task.progress"
      ? `task ${e.taskId}`
      : null;

/**
 * A reply streams a few characters an event, and clients only add each to what came before. Text for
 * the same message or task is joined for up to BATCH_MS; any other event sends what's waiting first, so
 * the order holds.
 */
export function batchText(send: (e: HatbotEvent) => void) {
  const waiting = new Map<string, Text>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    for (const e of waiting.values()) send(e);
    waiting.clear();
  };
  return {
    push(e: HatbotEvent) {
      const key = textKey(e);
      if (!key) {
        flush();
        return send(e);
      }
      const t = e as Text;
      const before = waiting.get(key);
      waiting.set(key, before ? { ...before, text: before.text + t.text } : t);
      timer ??= setTimeout(flush, BATCH_MS);
    },
    stop() {
      clearTimeout(timer);
      waiting.clear();
    },
  };
}

// One socket per client for live events (PLAN.md §8). Browsers authenticate with the session cookie,
// which needs an Origin check (cross-site WebSocket hijacking); apps send a bearer token.
export const streamRoutes = new Hono<AppEnv>().get(
  "/stream",
  async (c, next) => {
    const principal = principalOf(c, { renew: false });
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind === "session" && c.req.header("origin") !== c.var.config.publicUrl) {
      return c.json({ error: "bad origin" }, 403);
    }
    c.set("principal", principal);
    await next();
  },
  upgradeWebSocket((c) => {
    const { events, settings, auth, principal } = (c as Context<AppEnv>).var;
    let off: (() => void) | undefined;
    let batch: ReturnType<typeof batchText> | undefined;
    let forget: (() => void) | undefined;
    return {
      onOpen(_, ws) {
        // Signing out or revoking the token ends the socket too.
        forget = auth.onEnd(principal, () => ws.close(1008, "Signed out"));
        // Compressed where the client takes it (main.ts): JSON shrinks to a fraction.
        const send = (e: unknown) => ws.send(JSON.stringify(e), { compress: true });
        send({ type: "paused", paused: settings.get().paused });
        batch = batchText(send);
        off = events.on(batch.push);
      },
      onClose() {
        off?.();
        batch?.stop();
        forget?.();
      },
    };
  }),
);
