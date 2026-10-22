import { DecideApproval, TokenDecision } from "@hatbot/shared";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { pauseAll } from "./admin";
import { found, id, json, query } from "./util";

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
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        botId: z.string().max(40).optional(),
        origin: z.string().max(40).optional(),
        ids: z
          .string()
          .regex(/^\d+(,\d+){0,199}$/)
          .transform((s) => s.split(",").map(Number))
          .optional(),
        // Cards (TaskCard): what a chat's card or a row shows, without a webhook's 20,000-character
        // event or the cost. Older apps want whole tasks, so it's asked for.
        view: z.enum(["card"]).optional(),
      }),
    ),
    (c) => {
      const { view, ...q } = c.req.valid("query");
      const opts = q.ids ? { ...q, limit: q.ids.length } : q;
      return c.json(view === "card" ? c.var.tasks.cards(opts) : c.var.tasks.list(opts));
    },
  )
  .get(
    "/tasks/:id",
    query(z.object({ afterStep: z.coerce.number().int().min(0).optional() })),
    (c) => {
      const taskId = id(c);
      const task = c.var.tasks.get(taskId);
      if (!task) return c.json({ error: "That's gone." }, 404);
      return c.json({
        task,
        steps: c.var.tasks.steps(taskId, c.req.valid("query").afterStep),
        attachments: c.var.attachments.forTask(taskId),
      });
    },
  )
  .post("/tasks/:id/rerun", json(Rerun), (c) => {
    const old = c.var.tasks.get(id(c));
    if (!old) return c.json({ error: "That's gone." }, 404);
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
    if (!c.var.tasks.cancel(id(c))) return c.json({ error: "That task isn't running." }, 409);
    return c.json({ ok: true });
  })
  .get("/tasks/:id/screens/:stepId", (c) => {
    const step = c.var.tasks.step(id(c), Number(c.req.param("stepId")));
    const file = step?.screenshot ? c.var.archive.file(step.screenshot) : null;
    if (!file) return c.json({ error: "That's gone." }, 404);
    return new Response(file, {
      headers: {
        "content-type": "image/webp",
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  });

export const approvalRoutes = new Hono<AppEnv>()
  // An ntfy button: no session, the signed token is the authority.
  .post("/approvals/:id/token-decision", json(TokenDecision), (c) => {
    const approvalId = id(c);
    const { decision, exp, sig } = c.req.valid("json");
    if (!c.var.approvals.verify(approvalId, decision, exp, sig))
      return c.json({ error: "This link has expired." }, 403);
    const approval = c.var.approvals.decide(approvalId, decision, "ntfy");
    if (approval) return c.json({ ok: true, status: approval.status });
    // Still waiting: one a notification can't approve, like money or a mandate.
    return c.var.approvals.get(approvalId)?.status === "pending"
      ? c.json({ error: "Open Hatbot to approve this." }, 403)
      : c.json({ error: "That was already answered." }, 409);
  })
  // A notification's Pause all: no session either. Pausing is always safe, and resuming needs you.
  .post("/pause-all/token", json(TokenPause), (c) => {
    const { exp, sig } = c.req.valid("json");
    if (!c.var.approvals.verifyPause(exp, sig))
      return c.json({ error: "This link has expired." }, 403);
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
  .get("/approvals/:id", (c) => found(c, c.var.approvals.get(id(c))))
  .post("/approvals/:id", json(DecideApproval), (c) => {
    const { decision, note, scope } = c.req.valid("json");
    const asked = c.var.approvals.get(id(c));
    if (scope && asked && !asked.scopes.includes(scope))
      return c.json({ error: "This approval can only be given once." }, 400);
    const approval = c.var.approvals.decide(id(c), decision, "web", note, scope);
    if (!approval) return c.json({ error: "That was already answered." }, 409);
    return c.json(approval);
  })
  .get("/approval-rules", (c) => c.json(c.var.approvals.rules()))
  .delete("/approval-rules/:id", (c) =>
    c.var.approvals.removeRule(id(c))
      ? c.json({ ok: true })
      : c.json({ error: "That's gone." }, 404),
  );
