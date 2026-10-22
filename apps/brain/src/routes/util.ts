import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../context";
import { UserError } from "../errors";

export const badRequest = (c: Context, error?: { issues: readonly z.core.$ZodIssue[] }) => {
  const issue = error?.issues[0];
  if (!issue) return c.json({ error: "Something in that request isn't right." }, 400);
  const field = issue.path.map(String).join(".");
  return c.json(field ? { error: issue.message, field } : { error: issue.message }, 400);
};

/**
 * Whether the session or token a request came with ended while its body came in. It was checked
 * before the body, which can take minutes, and signing out elsewhere has to stop it too.
 */
export const signedOut = (c: Context) => {
  const { auth, principal } = (c as Context<AppEnv>).var;
  return Boolean(principal && !auth.alive(principal));
};

export const json = <S extends z.ZodType>(schema: S) =>
  zValidator("json", schema, (r, c) =>
    signedOut(c)
      ? c.json({ error: "You're not signed in." }, 401)
      : r.success
        ? undefined
        : badRequest(c, r.error),
  );

export const query = <S extends z.ZodType>(schema: S) =>
  zValidator("query", schema, (r, c) => (r.success ? undefined : badRequest(c, r.error)));

export const id = (c: { req: { param: (k: string) => string | undefined } }) =>
  Number(c.req.param("id"));

export const knownBot = (c: { var: AppEnv["Variables"] }, botId: string | undefined) => {
  if (botId !== undefined && !c.var.bots.active(botId)) throw new UserError("No such bot.");
};

export const found = <T extends object>(
  c: Context,
  x: T | null | undefined,
  gone = "That's gone.",
) => (x ? c.json(x) : c.json({ error: gone }, 404));
