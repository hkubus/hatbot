import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { z } from "zod";

/** 400 with zod's first issue: what's wrong, and in which field. */
export const badRequest = (c: Context, error?: { issues: readonly z.core.$ZodIssue[] }) => {
  const issue = error?.issues[0];
  if (!issue) return c.json({ error: "invalid request" }, 400);
  const field = issue.path.map(String).join(".");
  return c.json(field ? { error: issue.message, field } : { error: issue.message }, 400);
};

export const json = <S extends z.ZodType>(schema: S) =>
  zValidator("json", schema, (r, c) => (r.success ? undefined : badRequest(c, r.error)));

export const query = <S extends z.ZodType>(schema: S) =>
  zValidator("query", schema, (r, c) => (r.success ? undefined : badRequest(c, r.error)));
