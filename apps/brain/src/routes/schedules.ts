import { CreateSchedule, CreateTrigger, UpdateSchedule, UpdateTrigger } from "@hatbot/shared";
import { type Context, Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import type { AppEnv } from "../context";
import type { Received } from "../triggers";
import { found, id, json, knownBot } from "./util";

/** Webhook bodies bigger than this are refused. */
const MAX_HOOK_BYTES = 256 * 1024;

export const scheduleRoutes = new Hono<AppEnv>()
  .use("/schedules", requireAuth)
  .use("/schedules/*", requireAuth)
  .use("/triggers", requireAuth)
  .use("/triggers/*", requireAuth)
  .get("/schedules", (c) => c.json(c.var.schedules.list()))
  .post("/schedules", json(CreateSchedule), (c) => {
    knownBot(c, c.req.valid("json").botId);
    return c.json(c.var.schedules.create(c.req.valid("json"), "owner"), 201);
  })
  .get("/schedules/:id", (c) => found(c, c.var.schedules.get(id(c))))
  .patch("/schedules/:id", json(UpdateSchedule), (c) => {
    knownBot(c, c.req.valid("json").botId);
    return found(c, c.var.schedules.update(id(c), c.req.valid("json")));
  })
  .delete("/schedules/:id", (c) =>
    c.var.schedules.delete(id(c)) ? c.json({ ok: true }) : c.json({ error: "That's gone." }, 404),
  )
  .post("/schedules/:id/run", (c) => {
    if (!c.var.schedules.get(id(c))) return c.json({ error: "That's gone." }, 404);
    if (c.var.settings.get().paused) return c.json({ error: "Hatbot is paused." }, 409);
    const task = c.var.schedules.runNow(id(c));
    return task ? c.json(task, 201) : c.json({ error: "Its last run is still going." }, 409);
  })
  .get("/triggers", (c) => c.json(c.var.triggers.list()))
  .post("/triggers", json(CreateTrigger), (c) => {
    knownBot(c, c.req.valid("json").botId);
    return c.json(c.var.triggers.create(c.req.valid("json")), 201);
  })
  .get("/triggers/:id", (c) => found(c, c.var.triggers.get(id(c))))
  .patch("/triggers/:id", json(UpdateTrigger), (c) => {
    knownBot(c, c.req.valid("json").botId);
    return found(c, c.var.triggers.update(id(c), c.req.valid("json")));
  })
  .post("/triggers/:id/secret", (c) => found(c, c.var.triggers.rotate(id(c))))
  .delete("/triggers/:id", (c) =>
    c.var.triggers.delete(id(c)) ? c.json({ ok: true }) : c.json({ error: "That's gone." }, 404),
  );

const answer = (r: Received) =>
  r.status === "started"
    ? { status: 202 as const, body: { ok: true, taskId: r.task.id } }
    : r.status === "test"
      ? { status: 200 as const, body: { ok: true } }
      : r.status === "waiting"
        ? { status: 202 as const, body: { ok: true, waitingUntil: r.until } }
        : { status: 200 as const, body: { ok: true, skipped: r.reason } };

/**
 * Reads at most MAX_HOOK_BYTES of the body, a chunk at a time, so an unsigned stranger can't make the
 * brain hold more than that before the signature is checked. Null if it's bigger.
 */
async function body(req: Request): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_HOOK_BYTES) return null;
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_HOOK_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const json_ = (text: string | null | undefined): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return undefined;
  }
};

/**
 * Uptime Kuma's event, whichever way its Webhook notification sends it: a JSON body (the default),
 * form data with the JSON in a `data` field, or GET with `msg`, `heartbeat` and `monitor` parameters.
 */
async function kumaEvent(c: Context<AppEnv>): Promise<object | "too large" | null> {
  const q = (k: string) => c.req.query(k);
  if (c.req.method === "GET") {
    if (!q("msg") && !q("heartbeat")) return null;
    return { msg: q("msg"), heartbeat: json_(q("heartbeat")), monitor: json_(q("monitor")) };
  }
  const bytes = await body(c.req.raw);
  if (!bytes) return "too large";
  const text = new TextDecoder().decode(bytes);
  const type = c.req.header("content-type") ?? "";
  let parsed: unknown;
  if (type.startsWith("multipart/form-data")) {
    const form = await new Response(bytes, { headers: { "content-type": type } })
      .formData()
      .catch(() => null);
    const data = form?.get("data");
    parsed = json_(typeof data === "string" ? data : null);
  } else {
    parsed = json_(text);
  }
  return parsed && typeof parsed === "object" ? parsed : null;
}

const kumaHook = async (c: Context<AppEnv>) => {
  const { triggers } = c.var;
  const hook = `hook kuma/${c.req.param("id")}`;
  // The secret as a bearer token (Additional Headers), or in the URL, which is easier to set up.
  const token =
    c.req.header("authorization") ??
    (c.req.query("token") ? `Bearer ${c.req.query("token")}` : undefined);
  if (!triggers.verifyKuma(id(c), token)) {
    console.log(
      `${hook}: refused, ${token ? "wrong secret" : "no secret"} or no such Kuma trigger`,
    );
    return c.json({ error: "unauthorized" }, 401);
  }
  const event = await kumaEvent(c);
  if (event === "too large") return c.json({ error: "too large" }, 413);
  if (!event) {
    console.log(
      `${hook}: refused, not an Uptime Kuma event (${c.req.header("content-type") ?? "no content type"})`,
    );
    return c.json({ error: "expected Uptime Kuma's JSON" }, 400);
  }
  const r = triggers.receiveKuma(id(c), event);
  console.log(
    `${hook}: ${r.status === "skipped" ? `skipped (${r.reason})` : r.status === "started" ? `started task #${r.task.id}` : r.status === "waiting" ? `waiting for more checks until ${r.until}` : "test message"}`,
  );
  const a = answer(r);
  return c.json(a.body, a.status);
};

// No session: the signature or the trigger's secret is the authority (PLAN.md §8).
export const hookRoutes = new Hono<AppEnv>()
  .post("/hooks/kuma/:id", kumaHook)
  .get("/hooks/kuma/:id", kumaHook)
  .post("/hooks/:id", async (c) => {
    const { triggers } = c.var;
    const hook = `hook ${c.req.param("id")}`;
    const bytes = await body(c.req.raw);
    if (!bytes) return c.json({ error: "too large" }, 413);
    const check = triggers.verifyWebhook(id(c), (h) => c.req.header(h), bytes);
    if (!check.ok) {
      console.log(`${hook}: refused, missing or wrong signature, or no such webhook trigger`);
      return c.json({ error: "unauthorized" }, 401);
    }
    const r = triggers.receiveWebhook(
      id(c),
      new TextDecoder().decode(bytes),
      check.replay,
      check.keys,
    );
    console.log(
      `${hook}: ${r.status === "started" ? `started task #${r.task.id}` : `skipped (${r.status === "skipped" ? r.reason : r.status})`}`,
    );
    const a = answer(r);
    return c.json(a.body, a.status);
  });
