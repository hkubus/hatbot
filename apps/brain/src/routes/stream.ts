import type { ComputersService } from "@hatbot/plugin-computer";
import type { DesktopState, HatbotEvent } from "@hatbot/shared";
import { type Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { principalOf } from "../auth/middleware";
import { briefBot } from "../bots";
import type { AppEnv } from "../context";

/** With the Desktop plugin off. */
const NO_DESKTOP: DesktopState = {
  online: false,
  control: "hatbot",
  request: null,
  activeTaskId: null,
  botId: null,
};

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

// Browsers authenticate with the session cookie, which needs an Origin check (cross-site WebSocket
// hijacking); apps send a bearer token.
export const streamRoutes = new Hono<AppEnv>().get(
  "/stream",
  async (c, next) => {
    const principal = principalOf(c, { renew: false });
    if (!principal) return c.json({ error: "You're not signed in." }, 401);
    const { publicUrl } = c.var.config;
    if (principal.kind === "session" && c.req.header("origin") !== publicUrl)
      return c.json({ error: `Open Hatbot at ${publicUrl} to make changes.` }, 403);
    c.set("principal", principal);
    await next();
  },
  upgradeWebSocket((c) => {
    const v = (c as Context<AppEnv>).var;
    const { events, settings, auth, principal } = v;
    let off: (() => void) | undefined;
    let batch: ReturnType<typeof batchText> | undefined;
    let forget: (() => void) | undefined;
    return {
      onOpen(_, ws) {
        // Signing out or revoking the token ends the socket too.
        forget = auth.onEnd(principal, () => ws.close(1008, "Signed out"));
        // Compressed where the client takes it (main.ts): JSON shrinks to a fraction.
        const send = (e: unknown) => ws.send(JSON.stringify(e), { compress: true });
        // Read and sent before listening, all in this turn, so no event falls between the two.
        const paused = settings.get().paused;
        send({
          type: "snapshot",
          paused,
          bots: v.bots.list().map(briefBot),
          conversations: v.chats.list(),
          approvals: v.approvals.list(true),
          questions: v.questions.pending(),
          desktop: v.desktop()?.control.get() ?? NO_DESKTOP,
          computers: v.plugins.service<ComputersService>("computers")?.list() ?? [],
          unread: v.chats.unread(),
        } satisfies HatbotEvent);
        // Apps from before the snapshot.
        send({ type: "paused", paused });
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
