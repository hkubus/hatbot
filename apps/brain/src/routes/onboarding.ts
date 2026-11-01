import { type SetupEvent, SetupModels, SetupTurn } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { UserError } from "../errors";
import { json } from "./util";

export const onboardingRoutes = new Hono<AppEnv>()
  .use("/onboarding", requireAuth)
  .use("/onboarding/*", requireAuth)
  .get("/onboarding", (c) => c.json(c.var.onboarding.state()))
  .post("/onboarding/models", json(SetupModels), async (c) => {
    try {
      return c.json(await c.var.onboarding.setModels(c.req.valid("json")));
    } catch (err) {
      if (err instanceof UserError) return c.json({ error: err.message, field: "key" }, 400);
      throw err;
    }
  })
  // The bot's answer streams as lines of JSON, one SetupEvent each. It carries on if the page goes.
  .post("/onboarding/turn", json(SetupTurn), (c) => {
    const turn = c.req.valid("json");
    const { onboarding } = c.var;
    onboarding.check(turn);
    const encoder = new TextEncoder();
    let out: ReadableStreamDefaultController<Uint8Array> | null = null;
    const emit = (e: SetupEvent) => {
      try {
        out?.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      } catch {
        out = null;
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        out = controller;
        void onboarding
          .turn(turn, emit)
          .catch((err) => console.error("setup turn failed", err))
          .finally(() => {
            try {
              out?.close();
            } catch {}
          });
      },
      cancel() {
        out = null;
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  })
  .post("/onboarding/finish", (c) => c.json(c.var.onboarding.finish()))
  .post("/onboarding/again", (c) => c.json(c.var.onboarding.again()));
