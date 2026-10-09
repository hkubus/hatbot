import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { z } from "zod";

export const badRequest = (c: Context) => c.json({ error: "invalid request" }, 400);

export const json = <S extends z.ZodType>(schema: S) =>
  zValidator("json", schema, (r, c) => (r.success ? undefined : badRequest(c)));

export const query = <S extends z.ZodType>(schema: S) =>
  zValidator("query", schema, (r, c) => (r.success ? undefined : badRequest(c)));
