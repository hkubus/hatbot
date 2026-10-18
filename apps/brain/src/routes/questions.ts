import { AnswerQuestion } from "@hatbot/shared";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import { json } from "./util";

// Background tasks' questions to you (PLAN.md §20): the ones waiting, and your answer.
export const questionRoutes = new Hono<AppEnv>()
  .use("/questions", requireAuth)
  .use("/questions/*", requireAuth)
  .get("/questions", (c) => c.json(c.var.questions.pending()))
  .post("/questions/:id", json(AnswerQuestion), (c) => {
    const answered = c.var.questions.answer(Number(c.req.param("id")), c.req.valid("json").answer);
    if (!answered) return c.json({ error: "It's no longer waiting for an answer." }, 409);
    return c.json(answered);
  });
