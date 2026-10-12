import { DecideApproval, TokenDecision } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json, query } from "./util";

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
      }),
    ),
    (c) => c.json(c.var.tasks.list(c.req.valid("query"))),
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
  .use("/approvals", requireAuth)
  .use("/approvals/*", requireAuth)
  .get("/approvals", query(z.object({ pending: z.enum(["1", "0"]).optional() })), (c) =>
    c.json(c.var.approvals.list(c.req.valid("query").pending === "1")),
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
