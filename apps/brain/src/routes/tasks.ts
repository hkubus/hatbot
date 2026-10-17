import { DecideApproval, TokenDecision } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { pauseAll } from "./admin";
import { json, query } from "./util";

const Rerun = z.object({ goal: z.string().max(8000).optional() });
const TokenPause = z.object({ exp: z.number().int(), sig: z.string().min(1).max(200) });

export const taskRoutes = new Hono<AppEnv>()
  .use("/tasks", requireAuth)
  .use("/tasks/*", requireAuth)
  .get(
    "/tasks",
    query(
      z.object({
        status: z.enum(["active", "done"]).optional(),
        scheduleId: z.coerce.number().int().optional(),
        triggerId: z.coerce.number().int().optional(),
        watcherId: z.coerce.number().int().optional(),
        // Pages: newest first, then before= the last id, until a page is short.
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        botId: z.string().max(40).optional(),
        origin: z.string().max(40).optional(),
        // A chat's task cards in one go: ids=3,5,8.
        ids: z
          .string()
          .regex(/^\d+(,\d+){0,199}$/)
          .transform((s) => s.split(",").map(Number))
          .optional(),
      }),
    ),
    (c) => {
      const q = c.req.valid("query");
      return c.json(c.var.tasks.list(q.ids ? { ...q, limit: q.ids.length } : q));
    },
  )
  .get("/tasks/:id", (c) => {
    const taskId = Number(c.req.param("id"));
    const task = c.var.tasks.get(taskId);
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json({
      task,
      steps: c.var.tasks.steps(taskId),
      attachments: c.var.attachments.forTask(taskId),
    });
  })
  // Runs an ended task again, with its goal as you edited it.
  .post("/tasks/:id/rerun", json(Rerun), (c) => {
    const old = c.var.tasks.get(Number(c.req.param("id")));
    if (!old) return c.json({ error: "not found" }, 404);
    if (old.parentId || old.lane !== "background")
      return c.json({ error: "Run the task that started it again." }, 400);
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    if (!c.var.bots.active(old.botId)) return c.json({ error: "Its bot has been deleted." }, 409);
    const task = c.var.tasks.rerun(old.id, c.req.valid("json").goal);
    if (task) return c.json(task, 201);
    return c.json(
      { error: old.finishedAt ? "Its last run is still going." : "It hasn't ended yet." },
      409,
    );
  })
  .post("/tasks/:id/cancel", (c) => {
    if (!c.var.tasks.cancel(Number(c.req.param("id"))))
      return c.json({ error: "not running" }, 409);
    return c.json({ ok: true });
  })
  .get("/tasks/:id/screens/:stepId", (c) => {
    const step = c.var.tasks.step(Number(c.req.param("id")), Number(c.req.param("stepId")));
    const file = step?.screenshot ? c.var.archive.file(step.screenshot) : null;
    if (!file) return c.json({ error: "not found" }, 404);
    return new Response(file, {
      headers: {
        "content-type": "image/webp",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });

export const approvalRoutes = new Hono<AppEnv>()
  // An ntfy button: no session, the signed token is the authority (PLAN.md §6.2).
  .post("/approvals/:id/token-decision", json(TokenDecision), (c) => {
    const approvalId = Number(c.req.param("id"));
    const { decision, exp, sig } = c.req.valid("json");
    if (!c.var.approvals.verify(approvalId, decision, exp, sig))
      return c.json({ error: "invalid or expired" }, 403);
    const approval = c.var.approvals.decide(approvalId, decision, "ntfy");
    if (!approval) return c.json({ error: "already decided" }, 409);
    return c.json({ ok: true, status: approval.status });
  })
  // A notification's Pause all: no session either. Pausing is always safe, and resuming needs you.
  .post("/pause-all/token", json(TokenPause), (c) => {
    const { exp, sig } = c.req.valid("json");
    if (!c.var.approvals.verifyPause(exp, sig)) return c.json({ error: "invalid or expired" }, 403);
    pauseAll(c.var);
    console.log("paused from a notification");
    return c.json({ paused: true });
  })
  .use("/approvals", requireAuth)
  .use("/approvals/*", requireAuth)
  .get(
    "/approvals",
    query(
      z.object({
        pending: z.enum(["1", "0"]).optional(),
        before: z.coerce.number().int().optional(),
      }),
    ),
    (c) => {
      const { pending, before } = c.req.valid("query");
      return c.json(c.var.approvals.list(pending === "1", before));
    },
  )
  .get("/approvals/:id", (c) => {
    const approval = c.var.approvals.get(Number(c.req.param("id")));
    return approval ? c.json(approval) : c.json({ error: "not found" }, 404);
  })
  .post("/approvals/:id", json(DecideApproval), (c) => {
    const { decision, note } = c.req.valid("json");
    const approval = c.var.approvals.decide(Number(c.req.param("id")), decision, "web", note);
    if (!approval) return c.json({ error: "already decided" }, 409);
    return c.json(approval);
  });
