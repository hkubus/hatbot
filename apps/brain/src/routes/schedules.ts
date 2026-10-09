import { CreateSchedule, CreateTrigger, UpdateSchedule, UpdateTrigger } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { ScheduleError } from "../schedules";
import type { Received } from "../triggers";
import { json } from "./util";

/** Webhook bodies bigger than this are refused. */
const MAX_HOOK_BYTES = 256 * 1024;

const id = (c: { req: { param: (k: string) => string } }) => Number(c.req.param("id"));

export const scheduleRoutes = new Hono<AppEnv>()
  .use("/schedules", requireAuth)
  .use("/schedules/*", requireAuth)
  .use("/triggers", requireAuth)
  .use("/triggers/*", requireAuth)
  .get("/schedules", (c) => c.json(c.var.schedules.list()))
  .post("/schedules", json(CreateSchedule), (c) => {
    try {
      return c.json(c.var.schedules.create(c.req.valid("json"), "owner"), 201);
    } catch (err) {
      if (err instanceof ScheduleError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .get("/schedules/:id", (c) => {
    const s = c.var.schedules.get(id(c));
    return s ? c.json(s) : c.json({ error: "not found" }, 404);
  })
  .patch("/schedules/:id", json(UpdateSchedule), (c) => {
    try {
      const s = c.var.schedules.update(id(c), c.req.valid("json"));
      return s ? c.json(s) : c.json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof ScheduleError) return c.json({ error: err.message }, 400);
      throw err;
    }
  })
  .delete("/schedules/:id", (c) =>
    c.var.schedules.delete(id(c)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  )
  .post("/schedules/:id/run", (c) => {
    if (!c.var.schedules.get(id(c))) return c.json({ error: "not found" }, 404);
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    const task = c.var.schedules.runNow(id(c));
    return task ? c.json(task, 201) : c.json({ error: "Its last run is still going." }, 409);
  })
  .get("/triggers", (c) => c.json(c.var.triggers.list()))
  .post("/triggers", json(CreateTrigger), (c) =>
    c.json(c.var.triggers.create(c.req.valid("json")), 201),
  )
  .get("/triggers/:id", (c) => {
    const t = c.var.triggers.get(id(c));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  })
  .patch("/triggers/:id", json(UpdateTrigger), (c) => {
    const t = c.var.triggers.update(id(c), c.req.valid("json"));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  })
  .post("/triggers/:id/secret", (c) => {
    const t = c.var.triggers.rotate(id(c));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  })
  .delete("/triggers/:id", (c) =>
    c.var.triggers.delete(id(c)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

const answer = (r: Received) =>
  r.status === "started"
    ? { status: 202 as const, body: { ok: true, taskId: r.task.id } }
    : r.status === "test"
      ? { status: 200 as const, body: { ok: true } }
      : { status: 200 as const, body: { ok: true, skipped: r.reason } };

/** Reads at most MAX_HOOK_BYTES of the body; null if it's bigger. */
async function body(req: Request): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_HOOK_BYTES) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > MAX_HOOK_BYTES ? null : bytes;
}

// No session: the signature or the trigger's secret is the authority (PLAN.md §8).
export const hookRoutes = new Hono<AppEnv>()
  .post("/hooks/kuma/:id", async (c) => {
    const { triggers } = c.var;
    if (!triggers.verifyKuma(id(c), c.req.header("authorization")))
      return c.json({ error: "unauthorized" }, 401);
    const bytes = await body(c.req.raw);
    if (!bytes) return c.json({ error: "too large" }, 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return c.json({ error: "expected JSON" }, 400);
    }
    if (!parsed || typeof parsed !== "object") return c.json({ error: "expected JSON" }, 400);
    const r = answer(triggers.receiveKuma(id(c), parsed));
    return c.json(r.body, r.status);
  })
  .post("/hooks/:id", async (c) => {
    const { triggers } = c.var;
    const bytes = await body(c.req.raw);
    if (!bytes) return c.json({ error: "too large" }, 413);
    const check = triggers.verifyWebhook(id(c), (h) => c.req.header(h), bytes);
    if (!check.ok) return c.json({ error: "unauthorized" }, 401);
    const r = answer(triggers.receiveWebhook(id(c), new TextDecoder().decode(bytes), check.replay));
    return c.json(r.body, r.status);
  });
