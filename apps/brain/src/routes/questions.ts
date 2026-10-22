import { AnswerQuestion, TokenAnswer } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json } from "./util";

export const questionRoutes = new Hono<AppEnv>()
  // An ntfy button: no session, the signed choice is the authority, as for approvals.
  .post("/questions/:id/token-answer", json(TokenAnswer), (c) => {
    const { choice, exp, sig } = c.req.valid("json");
    const answered = c.var.questions.answerByToken(Number(c.req.param("id")), choice, exp, sig);
    if (answered === undefined) return c.json({ error: "This link has expired." }, 403);
    if (!answered) return c.json({ error: "That was already answered." }, 409);
    return c.json({ ok: true });
  })
  .use("/questions", requireAuth)
  .use("/questions/*", requireAuth)
  .get("/questions", (c) => c.json(c.var.questions.pending()))
  .post("/questions/:id", json(AnswerQuestion), (c) => {
    const answered = c.var.questions.answer(Number(c.req.param("id")), c.req.valid("json").answer);
    if (!answered) return c.json({ error: "It's no longer waiting for an answer." }, 409);
    return c.json(answered);
  });
