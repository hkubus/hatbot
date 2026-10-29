import {
  bodyOf,
  found,
  idParam,
  type PluginEnv,
  PluginError,
  pluginRoutes,
} from "@hatbot/plugin-sdk";
import {
  CreateSchedule,
  CreateTrigger,
  CreateWatcher,
  HATBOT_ID,
  UpdateSchedule,
  UpdateTrigger,
  UpdateWatcher,
  WatchSourceInput,
} from "@hatbot/shared";
import type { Context } from "hono";
import { z } from "zod";
import type { Deps } from "./deps";
import type { Heartbeat } from "./heartbeat";
import type { WeeklyReport } from "./report";
import type { Schedules } from "./schedules";
import type { Received, Triggers } from "./triggers";
import type { Watchers } from "./watch/service";

const MAX_HOOK_BYTES = 256 * 1024;

type Parts = {
  schedules: Schedules;
  triggers: Triggers;
  watchers: Watchers;
  heartbeat: Heartbeat;
  report: WeeklyReport;
} & Pick<Deps, "settings" | "bots">;

const GONE = { error: "That's gone." };
const PAUSED = { error: "Hatbot is paused." };
const Preview = z.object({ source: WatchSourceInput, botId: z.string().optional() });

export function routes(p: Parts) {
  const { schedules, triggers, watchers, heartbeat, report, settings } = p;
  const knownBot = (botId: string | undefined) => {
    if (botId !== undefined && !p.bots.active(botId)) throw new PluginError("No such bot.");
  };
  return pluginRoutes()
    .get("/schedules", (c) => c.json(schedules.list()))
    .post("/schedules", async (c) => {
      const body = await bodyOf(c, CreateSchedule);
      knownBot(body.botId);
      return c.json(schedules.create(body, "owner"), 201);
    })
    .get("/schedules/:id", (c) => found(c, schedules.get(idParam(c))))
    .patch("/schedules/:id", async (c) => {
      const body = await bodyOf(c, UpdateSchedule);
      knownBot(body.botId);
      return found(c, schedules.update(idParam(c), body));
    })
    .post("/schedules/:id/trust", (c) => found(c, schedules.trust(idParam(c))))
    .delete("/schedules/:id", (c) =>
      schedules.delete(idParam(c)) ? c.json({ ok: true }) : c.json(GONE, 404),
    )
    .post("/schedules/:id/run", (c) => {
      if (!schedules.get(idParam(c))) return c.json(GONE, 404);
      if (settings.get().paused) return c.json(PAUSED, 409);
      const task = schedules.runNow(idParam(c));
      return task ? c.json(task, 201) : c.json({ error: "Its last run is still going." }, 409);
    })
    .get("/triggers", (c) => c.json(triggers.list()))
    .post("/triggers", async (c) => {
      const body = await bodyOf(c, CreateTrigger);
      knownBot(body.botId);
      return c.json(triggers.create(body), 201);
    })
    .get("/triggers/:id", (c) => found(c, triggers.get(idParam(c))))
    .patch("/triggers/:id", async (c) => {
      const body = await bodyOf(c, UpdateTrigger);
      knownBot(body.botId);
      return found(c, triggers.update(idParam(c), body));
    })
    .post("/triggers/:id/secret", (c) => found(c, triggers.rotate(idParam(c))))
    .delete("/triggers/:id", (c) =>
      triggers.delete(idParam(c)) ? c.json({ ok: true }) : c.json(GONE, 404),
    )
    .get("/watchers", (c) => c.json(watchers.list()))
    .post("/watchers", async (c) => {
      const body = await bodyOf(c, CreateWatcher);
      knownBot(body.botId);
      return c.json(await watchers.create(body, "owner"), 201);
    })
    .post("/watchers/preview", async (c) => {
      const { source, botId } = await bodyOf(c, Preview);
      knownBot(botId);
      return c.json(await watchers.preview(source, botId ?? HATBOT_ID));
    })
    .get("/watchers/:id", (c) => found(c, watchers.get(idParam(c))))
    .get("/watchers/:id/values", (c) => {
      if (!watchers.get(idParam(c))) return c.json(GONE, 404);
      const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
      return c.json(watchers.values(idParam(c), limit));
    })
    .patch("/watchers/:id", async (c) => {
      const body = await bodyOf(c, UpdateWatcher);
      knownBot(body.botId);
      return found(c, await watchers.update(idParam(c), body));
    })
    .post("/watchers/:id/check", async (c) => {
      if (!watchers.get(idParam(c))) return c.json(GONE, 404);
      if (settings.get().paused) return c.json(PAUSED, 409);
      return c.json(await watchers.checkNow(idParam(c)));
    })
    .post("/watchers/:id/trust", (c) => found(c, watchers.trust(idParam(c))))
    .delete("/watchers/:id", (c) =>
      watchers.delete(idParam(c)) ? c.json({ ok: true }) : c.json(GONE, 404),
    )
    .get("/heartbeat", (c) => c.json(heartbeat.info()))
    .post("/heartbeat/run", async (c) => {
      if (settings.get().paused) return c.json(PAUSED, 409);
      return c.json(await heartbeat.run());
    })
    .get("/report", async (c) => c.json(await report.make()))
    .post("/report/send", async (c) => c.json({ text: await report.send() }))
    .post("/hooks/kuma/:id", (c) => kumaHook(c, triggers))
    .get("/hooks/kuma/:id", (c) => kumaHook(c, triggers))
    .post("/hooks/:id", (c) => webhook(c, triggers));
}

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
async function kumaEvent(c: Context<PluginEnv>): Promise<object | "too large" | null> {
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

// No session: the signature or the trigger's secret is the authority.
const kumaHook = async (c: Context<PluginEnv>, triggers: Triggers) => {
  const hook = `hook kuma/${c.req.param("id")}`;
  // The secret as a bearer token (Additional Headers), or in the URL, which is easier to set up.
  const token =
    c.req.header("authorization") ??
    (c.req.query("token") ? `Bearer ${c.req.query("token")}` : undefined);
  if (!triggers.verifyKuma(idParam(c), token)) {
    console.log(
      `${hook}: refused, ${token ? "wrong secret" : "no secret"} or no such Kuma trigger`,
    );
    return c.json({ error: "Wrong or missing secret." }, 401);
  }
  const event = await kumaEvent(c);
  if (event === "too large") return c.json({ error: "too large" }, 413);
  if (!event) {
    console.log(
      `${hook}: refused, not an Uptime Kuma event (${c.req.header("content-type") ?? "no content type"})`,
    );
    return c.json({ error: "expected Uptime Kuma's JSON" }, 400);
  }
  const r = triggers.receiveKuma(idParam(c), event);
  console.log(
    `${hook}: ${r.status === "skipped" ? `skipped (${r.reason})` : r.status === "started" ? `started task #${r.task.id}` : r.status === "waiting" ? `waiting for more checks until ${r.until}` : "test message"}`,
  );
  const a = answer(r);
  return c.json(a.body, a.status);
};

const webhook = async (c: Context<PluginEnv>, triggers: Triggers) => {
  const hook = `hook ${c.req.param("id")}`;
  const bytes = await body(c.req.raw);
  if (!bytes) return c.json({ error: "too large" }, 413);
  const check = triggers.verifyWebhook(idParam(c), (h) => c.req.header(h), bytes);
  if (!check.ok) {
    console.log(`${hook}: refused, missing or wrong signature, or no such webhook trigger`);
    return c.json({ error: "Wrong or missing signature." }, 401);
  }
  const r = triggers.receiveWebhook(
    idParam(c),
    new TextDecoder().decode(bytes),
    check.replay,
    check.keys,
  );
  console.log(
    `${hook}: ${r.status === "started" ? `started task #${r.task.id}` : `skipped (${r.status === "skipped" ? r.reason : r.status})`}`,
  );
  const a = answer(r);
  return c.json(a.body, a.status);
};
