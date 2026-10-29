import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  Db,
  EventsHost,
  Notifier,
  SearchRoutine,
  SettingsHost,
  TaskOrigin,
  TasksHost,
} from "@hatbot/plugin-sdk";
import {
  API_PREFIX,
  HATBOT_ID,
  type Task,
  type Trigger,
  type TriggerWithSecret,
} from "@hatbot/shared";
import { orphaned } from "./deps";

const MAX_SKEW_S = 300;
const REPLAY_WINDOW_MS = 30 * 24 * 3600_000;
/** A forge retrying a delivery sends it again with the same id. */
const DELIVERY_HEADERS = ["x-github-delivery", "x-gitea-delivery", "x-forgejo-delivery"];
const MAX_PAYLOAD_CHARS = 20_000;
const KUMA_INTERVAL_S = { fallback: 60, min: 20, max: 900 };
/** Time for the check after the wait to run and its "up" to reach us. */
const KUMA_SLACK_MS = 30_000;
/** A monitor down again this soon after its last alert task ended goes on that task's timeline. */
const ALERT_COOLDOWN_MS = 3600_000;
/** A day's tasks per trigger, so a flapping monitor or a busy forge can't run up a bill. */
const MAX_TASKS_PER_DAY = 24;

type Row = {
  id: number;
  name: string;
  kind: Trigger["kind"];
  secret: string;
  trusted: number;
  prompt: string;
  enabled: number;
  confirm_checks: number;
  created_at: string;
  last_fired_at: string | null;
  last_task_id: number | null;
  bot_id: string;
};

const SELECT = `SELECT g.*, (SELECT max(id) FROM tasks t WHERE t.trigger_id = g.id) AS last_task_id
  FROM triggers g`;

export type Received =
  | { status: "started"; task: Task }
  | {
      status: "skipped";
      /** recent: went on the timeline of the monitor's last task. */
      reason: "paused" | "running" | "disabled" | "duplicate" | "ignored" | "recent" | "limit";
    }
  | { status: "waiting"; until: string }
  | { status: "test" };

/** Uptime Kuma's webhook body (its "Application/json" preset). */
type KumaBody = {
  heartbeat?: { status?: number; msg?: string; time?: string } | null;
  monitor?: {
    id?: number;
    name?: string;
    url?: string;
    hostname?: string;
    type?: string;
    interval?: number;
  } | null;
  msg?: string;
};

export class Triggers {
  private prunedAt = 0;

  constructor(
    private db: Db,
    private events: EventsHost,
    private settings: SettingsHost,
    private tasks: TasksHost,
    private notifier: Notifier,
    private publicUrl: string,
    private clock: () => number = Date.now,
  ) {}

  private toTrigger = (r: Row): Trigger => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    trusted: r.kind === "kuma" || Boolean(r.trusted),
    prompt: r.prompt,
    enabled: Boolean(r.enabled),
    confirmChecks: r.confirm_checks,
    url: `${this.publicUrl}${API_PREFIX}/hooks/${r.kind === "kuma" ? "kuma/" : ""}${r.id}`,
    createdAt: r.created_at,
    lastFiredAt: r.last_fired_at,
    lastTaskId: r.last_task_id,
    botId: r.bot_id,
  });

  private now() {
    return new Date(this.clock()).toISOString();
  }

  list(): Trigger[] {
    return this.db.query<Row, []>(`${SELECT} ORDER BY g.name, g.id`).all().map(this.toTrigger);
  }

  get(id: number): Trigger | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE g.id = ?`).get(id);
    return r ? this.toTrigger(r) : null;
  }

  create(input: {
    name: string;
    kind: Trigger["kind"];
    prompt: string;
    trusted?: boolean;
    confirmChecks?: number;
    botId?: string;
  }): TriggerWithSecret {
    const secret = newSecret();
    const row = this.db
      .query<{ id: number }, [string, string, string, number, string, number, string, string]>(
        `INSERT INTO triggers (name, kind, secret, trusted, prompt, confirm_checks, created_at, bot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.name,
        input.kind,
        secret,
        input.trusted ? 1 : 0,
        input.prompt,
        input.confirmChecks ?? 0,
        this.now(),
        input.botId ?? HATBOT_ID,
      );
    const trigger = this.changed(row?.id ?? -1) as Trigger;
    return { ...trigger, secret };
  }

  update(
    id: number,
    patch: {
      name?: string;
      prompt?: string;
      trusted?: boolean;
      enabled?: boolean;
      confirmChecks?: number;
      botId?: string;
    },
  ): Trigger | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE g.id = ?`).get(id);
    if (!r) return null;
    this.db
      .query(
        "UPDATE triggers SET name = ?, prompt = ?, trusted = ?, enabled = ?, confirm_checks = ?, bot_id = ? WHERE id = ?",
      )
      .run(
        patch.name ?? r.name,
        patch.prompt ?? r.prompt,
        (patch.trusted ?? Boolean(r.trusted)) ? 1 : 0,
        (patch.enabled ?? Boolean(r.enabled)) ? 1 : 0,
        patch.confirmChecks ?? r.confirm_checks,
        patch.botId ?? r.bot_id,
        id,
      );
    return this.changed(id);
  }

  rotate(id: number): TriggerWithSecret | null {
    const secret = newSecret();
    if (!this.db.query("UPDATE triggers SET secret = ? WHERE id = ?").run(secret, id).changes)
      return null;
    return { ...(this.get(id) as Trigger), secret };
  }

  delete(id: number): boolean {
    const gone = this.db.query("DELETE FROM triggers WHERE id = ?").run(id).changes > 0;
    if (gone) this.events.emit({ type: "trigger.deleted", id });
    return gone;
  }

  /**
   * A generic webhook's signature, HMAC-SHA256 with the trigger's secret. Any of:
   * - `X-Hatbot-Signature: t=<unix seconds>,v1=<hex of HMAC("<t>.<body>")>`, within 5 minutes
   * - `X-Hub-Signature-256: sha256=<hex of HMAC(body)>` (GitHub, Forgejo)
   * - `X-Forgejo-Signature` or `X-Gitea-Signature: <hex of HMAC(body)>`
   */
  verifyWebhook(id: number, header: (name: string) => string | undefined, body: Uint8Array) {
    const secret = this.secretOf(id, "webhook");
    if (!secret) return { ok: false as const };
    const mac = (data: Uint8Array | string) =>
      createHmac("sha256", secret).update(data).digest("hex");
    let sig: string | undefined;
    let want: string | undefined;
    const hatbot = header("x-hatbot-signature");
    if (hatbot) {
      const parts = Object.fromEntries(hatbot.split(",").map((p) => p.trim().split("=", 2)));
      const t = Number(parts.t);
      if (!Number.isInteger(t) || Math.abs(this.clock() / 1000 - t) > MAX_SKEW_S)
        return { ok: false as const };
      sig = parts.v1;
      want = mac(Buffer.concat([Buffer.from(`${t}.`), body]));
    } else {
      sig =
        header("x-hub-signature-256")?.replace(/^sha256=/, "") ??
        header("x-forgejo-signature") ??
        header("x-gitea-signature");
      want = mac(body);
    }
    if (!sig || !sameText(sig.toLowerCase(), want)) return { ok: false as const };
    // The same signed body again is a replay. A forge's delivery id isn't signed, so it can't make a
    // body new; it also catches a forge sending one delivery again. Real events differ in their own
    // ids and times, so two never share a body.
    const delivery = DELIVERY_HEADERS.map(header).find(Boolean);
    const keys = [`${id}:mac:${want}`];
    if (delivery) keys.push(`${id}:delivery:${delivery.slice(0, 200)}`);
    return { ok: true as const, replay: keys.some((k) => this.seen(k)), keys };
  }

  /** Uptime Kuma can't sign; it sends `Authorization: Bearer <secret>` from its Additional Headers. */
  verifyKuma(id: number, authorization: string | undefined): boolean {
    const secret = this.secretOf(id, "kuma");
    const got = authorization?.replace(/^Bearer\s+/i, "").trim();
    return Boolean(secret && got && sameText(got, secret));
  }

  /**
   * Only a delivery that started a task is remembered as seen, so one skipped while paused or off can be
   * delivered again.
   */
  receiveWebhook(id: number, body: string, replay: boolean, keys: string[] = []): Received {
    const t = this.get(id);
    if (!t) return { status: "skipped", reason: "disabled" };
    if (replay) return { status: "skipped", reason: "duplicate" };
    const r = this.startWebhook(t, body);
    if (r.status === "started") for (const key of keys) this.remember(key);
    return r;
  }

  private startWebhook(t: Trigger, body: string): Received {
    this.fired(t.id);
    const blocked = this.blocked(t) ?? this.limited(t);
    if (blocked) return blocked;
    const task = this.tasks.createBackgroundTask({
      title: t.name,
      goal: t.prompt,
      origin: "webhook",
      source: t.name,
      triggerId: t.id,
      botId: t.botId,
      runKey: `trigger:${t.id}`,
      payload: pretty(body),
      trusted: t.trusted,
    });
    if (!task) return { status: "skipped", reason: "running" };
    this.started(t);
    return { status: "started", task };
  }

  receiveKuma(id: number, body: KumaBody): Received {
    const t = this.get(id);
    if (!t) return { status: "skipped", reason: "disabled" };
    this.fired(id);
    const hb = body.heartbeat;
    const monitor = body.monitor;
    if (!hb || !monitor) {
      // Kuma's Test button: say it arrived, so setting it up has an answer.
      void this.notifier.send({
        title: `Uptime Kuma reached Hatbot`,
        message: `"${t.name}" got Kuma's test message. Down alerts will start a task.`,
        priority: 2,
        click: `${this.publicUrl}/triggers/${t.id}`,
      });
      return { status: "test" };
    }
    const name = monitor.name ?? `Monitor ${monitor.id ?? "?"}`;
    const runKey = `kuma:${t.id}:${monitor.id ?? name}`;
    const active = this.tasks.activeFor(runKey);
    const message = hb.msg || body.msg || "";
    const update = (taskId: number, what: string) => {
      // On its timeline the message is what the task has read, before it gets to its inbox.
      if (message && !kumaSaid(message)) this.tasks.taint(taskId, alertMessageSource(name));
      this.tasks.addStep(taskId, {
        kind: "note",
        name: `${name} ${what}`,
        detail: message,
        url: null,
      });
      this.tasks.tell(
        taskId,
        JSON.stringify({ monitor: name, status: what, message, time: hb.time ?? this.now() }),
      );
    };
    if (hb.status === 1) {
      if (this.db.query("DELETE FROM kuma_waiting WHERE run_key = ?").run(runKey).changes)
        console.log(`kuma: ${name} came back up in time; dropped its alert`);
      if (active) update(active.id, "is back up");
      else this.again(runKey, `${name} is back up`, message, name);
      return { status: "skipped", reason: "ignored" };
    }
    if (hb.status !== 0) return { status: "skipped", reason: "ignored" };
    if (active) {
      update(active.id, "is still down");
      return { status: "skipped", reason: "running" };
    }
    const blocked = this.blocked(t);
    if (blocked) return blocked;
    const waiting = this.db
      .query<{ due_at: string }, [string]>("SELECT due_at FROM kuma_waiting WHERE run_key = ?")
      .get(runKey);
    if (waiting && waiting.due_at > this.now()) return { status: "waiting", until: waiting.due_at };
    const alert = JSON.stringify(
      {
        monitor: name,
        type: monitor.type,
        url: monitor.url,
        hostname: monitor.hostname,
        status: "down",
        message,
        time: hb.time,
      },
      null,
      2,
    );
    let wait = 0;
    if (t.confirmChecks > 0) {
      const raw = Number(monitor.interval);
      const interval = Number.isFinite(raw) && raw > 0 ? raw : KUMA_INTERVAL_S.fallback;
      const each = Math.min(KUMA_INTERVAL_S.max, Math.max(KUMA_INTERVAL_S.min, interval));
      wait = t.confirmChecks * each * 1000 + KUMA_SLACK_MS;
    }
    if (waiting) this.db.query("DELETE FROM kuma_waiting WHERE run_key = ?").run(runKey);
    return this.startAlert(t, runKey, name, alert, wait);
  }

  private wait(t: Trigger, runKey: string, until: string, name: string, alert: string) {
    this.db
      .query(
        `INSERT INTO kuma_waiting (run_key, trigger_id, due_at, name, alert) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_key) DO UPDATE SET trigger_id = excluded.trigger_id,
           due_at = excluded.due_at, name = excluded.name, alert = excluded.alert`,
      )
      .run(runKey, t.id, until, name, alert);
  }

  tick() {
    this.prune();
    const due = this.db
      .query<{ run_key: string; trigger_id: number; name: string; alert: string }, [string]>(
        "SELECT run_key, trigger_id, name, alert FROM kuma_waiting WHERE due_at <= ? ORDER BY due_at",
      )
      .all(this.now());
    for (const w of due) {
      this.db.query("DELETE FROM kuma_waiting WHERE run_key = ?").run(w.run_key);
      const t = this.get(w.trigger_id);
      if (!t || this.blocked(t)) continue;
      const r = this.startAlert(t, w.run_key, w.name, w.alert);
      console.log(
        `kuma: ${w.name} is still down; ${r.status === "started" ? `started task #${r.task.id}` : `skipped (${r.status === "skipped" ? r.reason : r.status})`}`,
      );
    }
  }

  /**
   * News soon after the monitor's last alert task ended goes on that task's timeline, rather than a new
   * task each time a flapping monitor goes down. Kuma says nothing more while a monitor stays down, so a
   * down waits for the hour to be over and then starts a task, unless the monitor came back up.
   */
  private again(
    runKey: string,
    what: string,
    message: string,
    monitor: string,
    down?: { t: Trigger; name: string; alert: string; wait: number },
  ): Received | null {
    const cutoff = new Date(this.clock() - ALERT_COOLDOWN_MS).toISOString();
    const last = this.db
      .query<{ id: number; finished_at: string }, [string, string]>(
        "SELECT id, finished_at FROM tasks WHERE run_key = ? AND finished_at > ? ORDER BY id DESC LIMIT 1",
      )
      .get(runKey, cutoff);
    if (!last) return null;
    // Whoever reads the task now reads the message too.
    if (message && !kumaSaid(message)) this.tasks.taint(last.id, alertMessageSource(monitor));
    const told = down && this.tasks.steps(last.id).some((s) => s.name === what);
    this.tasks.addStep(last.id, { kind: "note", name: what, detail: message, url: null });
    if (!down) return { status: "skipped", reason: "recent" };
    const due = Math.max(
      Date.parse(last.finished_at) + ALERT_COOLDOWN_MS,
      this.clock() + down.wait,
    );
    this.wait(down.t, runKey, new Date(due).toISOString(), down.name, down.alert);
    if (!told)
      void this.notifier.send({
        title: what.slice(0, 120),
        message: `It went down again after task #${last.id} ended. If it's still down in ${Math.ceil((due - this.clock()) / 60_000)} minutes, a new task looks into it.`,
        priority: 3,
        click: `${this.publicUrl}/tasks/${last.id}`,
      });
    return { status: "skipped", reason: "recent" };
  }

  private limited(t: Trigger): Received | null {
    return this.startedToday(t.id) >= MAX_TASKS_PER_DAY
      ? { status: "skipped", reason: "limit" }
      : null;
  }

  private startedToday(id: number): number {
    const since = new Date(this.clock() - 86400_000).toISOString();
    return (
      this.db
        .query<{ n: number }, [number, string]>(
          "SELECT count(*) AS n FROM tasks WHERE trigger_id = ? AND parent_id IS NULL AND created_at > ?",
        )
        .get(id, since)?.n ?? 0
    );
  }

  /** Told once, since later events start nothing. */
  private started(t: Trigger) {
    if (this.startedToday(t.id) !== MAX_TASKS_PER_DAY) return;
    void this.notifier.send({
      title: `${t.name} is at its limit`.slice(0, 120),
      message: `It started ${MAX_TASKS_PER_DAY} tasks in the last 24 hours, the most it may. Its events start nothing more until fewer did.`,
      priority: 3,
      click: `${this.publicUrl}/triggers/${t.id}`,
    });
  }

  private startAlert(
    t: Trigger,
    runKey: string,
    name: string,
    payload: string,
    wait = 0,
  ): Received {
    const message = alertParts(payload)?.message ?? "";
    const again = this.again(runKey, `${name} is down again`, message, name, {
      t,
      name,
      alert: payload,
      wait,
    });
    if (again) return again;
    if (wait > 0) {
      const until = new Date(this.clock() + wait).toISOString();
      this.wait(t, runKey, until, name, payload);
      return { status: "waiting", until };
    }
    const limited = this.limited(t);
    if (limited) return limited;
    const task = this.tasks.createBackgroundTask({
      title: `${name} is down`,
      goal: t.prompt,
      origin: "alert",
      source: t.name,
      triggerId: t.id,
      botId: t.botId,
      runKey,
      payload,
      // Kuma's own fields are trusted; its message often quotes the service's response.
      trusted: true,
      taintedBy: message ? alertMessageSource(name) : null,
    });
    if (!task) return { status: "skipped", reason: "running" };
    this.started(t);
    return { status: "started", task };
  }

  private blocked(t: Trigger): Received | null {
    if (!t.enabled) return { status: "skipped", reason: "disabled" };
    if (orphaned(this.db, "triggers", t.id, t.botId)) {
      this.changed(t.id);
      return { status: "skipped", reason: "disabled" };
    }
    if (this.settings.get().paused) return { status: "skipped", reason: "paused" };
    return null;
  }

  private secretOf(id: number, kind: Trigger["kind"]): string | null {
    return (
      this.db
        .query<{ secret: string }, [number, string]>(
          "SELECT secret FROM triggers WHERE id = ? AND kind = ?",
        )
        .get(id, kind)?.secret ?? null
    );
  }

  private fired(id: number) {
    this.db.query("UPDATE triggers SET last_fired_at = ? WHERE id = ?").run(this.now(), id);
    this.changed(id);
  }

  /** Kept in the database, so a restart doesn't forget. */
  private seen(key: string): boolean {
    this.prune();
    const cutoff = new Date(this.clock() - REPLAY_WINDOW_MS).toISOString();
    return Boolean(
      this.db.query("SELECT 1 FROM hook_deliveries WHERE key = ? AND seen_at > ?").get(key, cutoff),
    );
  }

  /** A replay doesn't get here, so one seen before is from before the window. */
  private remember(key: string) {
    this.db
      .query(
        "INSERT INTO hook_deliveries (key, seen_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET seen_at = excluded.seen_at",
      )
      .run(key, this.now());
  }

  private prune() {
    if (this.clock() - this.prunedAt < 24 * 3600_000) return;
    this.prunedAt = this.clock();
    const cutoff = new Date(this.clock() - REPLAY_WINDOW_MS).toISOString();
    this.db.query("DELETE FROM hook_deliveries WHERE seen_at <= ?").run(cutoff);
  }

  private changed(id: number) {
    const trigger = this.get(id);
    if (trigger) this.events.emit({ type: "trigger.updated", trigger });
    return trigger;
  }

  search(pattern: string): SearchRoutine[] {
    return this.db
      .query<{ id: number; name: string }, [string]>(
        "SELECT id, name FROM triggers WHERE name LIKE ?1 ESCAPE '\\' OR prompt LIKE ?1 ESCAPE '\\'",
      )
      .all(pattern)
      .map((r) => ({ kind: "trigger" as const, ...r }));
  }

  /** A webhook's and an alert's tasks. An untrusted event isn't shown to the review, so it can't pick the target. */
  origins(): Record<"webhook" | "alert", TaskOrigin> {
    const standing = (task: Task) => {
      const kind = task.origin === "alert" ? "Uptime Kuma alert" : "webhook";
      const head = `Standing instructions for the ${kind} "${task.source ?? ""}":\n${task.goal}`;
      const trustedEvent =
        task.origin === "alert" ||
        this.db
          .query<{ trusted: number }, [number]>("SELECT trusted FROM triggers WHERE id = ?")
          .get(task.triggerId ?? -1)?.trusted === 1;
      // An alert's message can be written by whoever reaches the service: not shown either.
      const alert = task.origin === "alert" && task.payload ? alertParts(task.payload) : null;
      const event = alert
        ? `${alert.alert}${alert.message ? "\n\nIts message came from the monitored service and isn't trusted, so it isn't shown." : ""}`
        : (task.payload ?? "");
      return trustedEvent
        ? `${head}\n\nThe event that started this task (trusted):\n${event}`
        : `${head}\n\nThe event that started this task came from outside and isn't trusted, so it isn't shown: it can't choose what to act on.`;
    };
    return {
      webhook: { startedBy: (s) => `the webhook "${s}"`, standing },
      alert: {
        startedBy: (s) => `an Uptime Kuma alert, through "${s}"`,
        standing,
        event: alertEvent,
        reserve: true,
        overLimit: (limit, task) => notInvestigated(limit, task.payload),
      },
    };
  }
}

/** Kuma's own fields are trusted; its message is untrusted data. */
function alertEvent(text: string) {
  const a = alertParts(text);
  if (!a) return null;
  const monitor = String((JSON.parse(a.alert) as { monitor?: unknown }).monitor);
  return {
    trusted: a.alert,
    ...(a.message ? { untrusted: { source: alertMessageSource(monitor), text: a.message } } : {}),
  };
}

/** What an alert the limits stopped said, so you still hear it. */
function notInvestigated(limit: "daily" | "monthly", payload: string | null): string {
  let said = (payload ?? "").slice(0, 500);
  try {
    const a = JSON.parse(payload ?? "") as Record<string, unknown>;
    const where = a.url || a.hostname;
    said = `${a.monitor ?? "A monitor"}${where ? ` (${where})` : ""} is down${a.message ? `: ${a.message}` : "."}`;
  } catch {}
  const spent = limit === "daily" ? "today's" : "this month's";
  return `Not investigated: ${spent} limit is spent. The alert: ${said}`;
}

const newSecret = () => randomBytes(24).toString("base64url");

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** As Kuma writes a status: "502 - Bad Gateway". */
const REASONS =
  "OK|Created|Accepted|No Content|Moved Permanently|Found|See Other|Not Modified|Temporary Redirect|Permanent Redirect|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Request Timeout|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout";
/**
 * Messages Kuma writes itself, whatever the service sent: timeouts, status codes, connection and
 * certificate errors (2026-10-20, the owner's choice). Nothing a stranger chose fits in them; a
 * keyword monitor's "not found in [...]" quotes the page, so it doesn't.
 */
const KUMA_OWN = [
  /^timeout of \d+ms exceeded$/,
  /^Request failed with status code \d{3}$/,
  new RegExp(`^\\d{3} - (${REASONS})$`),
  /^(connect|read|write) (ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE) [\w.:[\]-]+$/,
  /^getaddrinfo (ENOTFOUND|EAI_AGAIN) [\w.-]+$/,
  /^(socket hang up|timeout|aborted|No heartbeat in the time window|certificate has expired|self[- ]signed certificate( in certificate chain)?|unable to verify the first certificate)$/i,
];
export const kumaSaid = (message: string) => KUMA_OWN.some((re) => re.test(message.trim()));

/**
 * What Kuma itself says is trusted. Any other message often quotes the monitored service's response,
 * so anyone who can reach the service can write it.
 */
export function alertParts(payload: string): { alert: string; message: string } | null {
  try {
    const { message, ...alert } = JSON.parse(payload) as Record<string, unknown>;
    if (typeof alert.monitor !== "string") return null;
    const text = typeof message === "string" ? message.trim() : "";
    if (kumaSaid(text))
      return { alert: JSON.stringify({ ...alert, message: text }, null, 2), message: "" };
    return { alert: JSON.stringify(alert, null, 2), message: text };
  } catch {
    return null;
  }
}

export const alertMessageSource = (monitor: string) => `The message in the alert for "${monitor}"`;

function pretty(body: string): string {
  let text = body;
  try {
    text = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON.
  }
  return text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}\n… (cut; ${text.length} characters in all)`
    : text;
}
