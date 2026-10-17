// Triggers (PLAN.md §4.1, §8): signed webhooks and Uptime Kuma alerts start background tasks.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_PREFIX,
  HATBOT_ID,
  type Task,
  type Trigger,
  type TriggerWithSecret,
} from "@hatbot/shared";
import { liveBot } from "./bots";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { Notifier } from "./notify";
import type { SettingsStore } from "./settings";
import type { Tasks } from "./tasks/service";

/** How far a signed timestamp may be from now. */
const MAX_SKEW_S = 300;
/** Signatures and delivery ids seen this recently are replays. */
const REPLAY_WINDOW_MS = 30 * 24 * 3600_000;
/** Headers with a delivery id: a forge retrying one sends it again with the same id. */
const DELIVERY_HEADERS = ["x-github-delivery", "x-gitea-delivery", "x-forgejo-delivery"];
/** What a run gets to see of a payload. */
const MAX_PAYLOAD_CHARS = 20_000;
/** A Kuma monitor's check interval when its alert doesn't say, and the range we believe. */
const KUMA_INTERVAL_S = { fallback: 60, min: 20, max: 900 };
/** Time for the check after the wait to run and its "up" to reach us. */
const KUMA_SLACK_MS = 30_000;
/** A monitor down again this soon after its last alert task ended goes on that task's timeline. */
const ALERT_COOLDOWN_MS = 3600_000;
/** Tasks one trigger may start in 24 hours, so a flapping monitor or a busy forge can't run up a bill. */
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
      /** recent: on the timeline of the monitor's last task; limit: the trigger's tasks for the day. */
      reason: "paused" | "running" | "disabled" | "duplicate" | "ignored" | "recent" | "limit";
    }
  /** A down alert waiting for the monitor's next checks before it starts a task. */
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
    /** Seconds between checks. */
    interval?: number;
  } | null;
  msg?: string;
};

export class Triggers {
  private clock: () => number;
  private prunedAt = 0;

  constructor(
    private db: Db,
    private events: EventBus,
    private settings: SettingsStore,
    private tasks: Tasks,
    private notifier: Notifier,
    private publicUrl: string,
    clock?: () => number,
  ) {
    this.clock = clock ?? Date.now;
  }

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

  /** A new secret; the old one stops working. */
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
    if (!sig || !same(sig.toLowerCase(), want)) return { ok: false as const };
    // A forge's delivery id names the delivery, so two with the same body are both run; without one,
    // the same signed body again is the replay.
    const delivery = DELIVERY_HEADERS.map(header).find(Boolean);
    const key = delivery ? `${id}:delivery:${delivery.slice(0, 200)}` : `${id}:mac:${want}`;
    return { ok: true as const, replay: this.seen(key), key };
  }

  /** Uptime Kuma can't sign; it sends `Authorization: Bearer <secret>` from its Additional Headers. */
  verifyKuma(id: number, authorization: string | undefined): boolean {
    const secret = this.secretOf(id, "kuma");
    const got = authorization?.replace(/^Bearer\s+/i, "").trim();
    return Boolean(secret && got && same(got, secret));
  }

  /**
   * A verified generic webhook: starts its run with the body as the payload. Only a delivery that
   * started one is remembered as seen, so one skipped while paused or off can be delivered again.
   */
  receiveWebhook(id: number, body: string, replay: boolean, key?: string): Received {
    const t = this.get(id);
    if (!t) return { status: "skipped", reason: "disabled" };
    if (replay) return { status: "skipped", reason: "duplicate" };
    const r = this.startWebhook(t, body);
    if (r.status === "started" && key) this.remember(key);
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
      botId: liveBot(this.db, t.botId),
      runKey: `trigger:${t.id}`,
      payload: pretty(body),
      trusted: t.trusted,
    });
    if (!task) return { status: "skipped", reason: "running" };
    this.started(t);
    return { status: "started", task };
  }

  /**
   * An Uptime Kuma event. "Down" starts an alert task per monitor, or first waits for the monitor's next
   * checks if the trigger says so, and drops the alert when it comes back up in time. More alerts while
   * the task runs, and the monitor coming back up, go on that task's timeline. Kuma's test message only
   * marks the trigger as heard from.
   */
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
    // More news while a task looks into it: on its timeline, and told to the task.
    const update = (taskId: number, what: string) => {
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
      else this.again(runKey, `${name} is back up`, message);
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
    if (waiting) return { status: "waiting", until: waiting.due_at };
    const again = this.again(runKey, `${name} is down again`, message);
    if (again) return again;
    const alert = {
      monitor: name,
      type: monitor.type,
      url: monitor.url,
      hostname: monitor.hostname,
      status: "down",
      message,
      time: hb.time,
    };
    if (t.confirmChecks > 0) {
      const raw = Number(monitor.interval);
      const interval = Number.isFinite(raw) && raw > 0 ? raw : KUMA_INTERVAL_S.fallback;
      const each = Math.min(KUMA_INTERVAL_S.max, Math.max(KUMA_INTERVAL_S.min, interval));
      const until = new Date(this.clock() + t.confirmChecks * each * 1000 + KUMA_SLACK_MS);
      this.db
        .query(
          "INSERT INTO kuma_waiting (run_key, trigger_id, due_at, name, alert) VALUES (?, ?, ?, ?, ?)",
        )
        .run(runKey, t.id, until.toISOString(), name, JSON.stringify(alert, null, 2));
      return { status: "waiting", until: until.toISOString() };
    }
    return this.startAlert(t, runKey, name, JSON.stringify(alert, null, 2));
  }

  /** Starts the alerts whose wait is over: their monitor didn't come back up. The brain calls it often. */
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
   * A monitor's news soon after its last alert task ended: on that task's timeline, rather than a new
   * task each time a flapping monitor goes down. Null when there's no such task.
   */
  private again(runKey: string, what: string, message: string): Received | null {
    const cutoff = new Date(this.clock() - ALERT_COOLDOWN_MS).toISOString();
    const last = this.db
      .query<{ id: number }, [string, string]>(
        "SELECT id FROM tasks WHERE run_key = ? AND finished_at > ? ORDER BY id DESC LIMIT 1",
      )
      .get(runKey, cutoff);
    if (!last) return null;
    this.tasks.addStep(last.id, { kind: "note", name: what, detail: message, url: null });
    return { status: "skipped", reason: "recent" };
  }

  /** Whether the trigger started its most tasks for a day already. */
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

  /** After the task that reached the day's limit: told once, since later events start nothing. */
  private started(t: Trigger) {
    if (this.startedToday(t.id) !== MAX_TASKS_PER_DAY) return;
    void this.notifier.send({
      title: `${t.name} is at its limit`.slice(0, 120),
      message: `It started ${MAX_TASKS_PER_DAY} tasks in the last 24 hours, the most it may. Its events start nothing more until fewer did.`,
      priority: 3,
      click: `${this.publicUrl}/triggers/${t.id}`,
    });
  }

  private startAlert(t: Trigger, runKey: string, name: string, payload: string): Received {
    const again = this.again(runKey, `${name} is down again`, "");
    if (again) return again;
    const limited = this.limited(t);
    if (limited) return limited;
    const task = this.tasks.createBackgroundTask({
      title: `${name} is down`,
      goal: t.prompt,
      origin: "alert",
      source: t.name,
      triggerId: t.id,
      botId: liveBot(this.db, t.botId),
      runKey,
      payload,
      // Kuma's own fields are trusted; its message often quotes the service's response.
      trusted: true,
      taintedBy: alertParts(payload)?.message ? alertMessageSource(name) : null,
    });
    if (!task) return { status: "skipped", reason: "running" };
    this.started(t);
    return { status: "started", task };
  }

  private blocked(t: Trigger): Received | null {
    if (!t.enabled) return { status: "skipped", reason: "disabled" };
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

  /** Whether a delivery ran within the window. Kept in the database, so a restart doesn't forget. */
  private seen(key: string): boolean {
    this.prune();
    const cutoff = new Date(this.clock() - REPLAY_WINDOW_MS).toISOString();
    return Boolean(
      this.db.query("SELECT 1 FROM hook_deliveries WHERE key = ? AND seen_at > ?").get(key, cutoff),
    );
  }

  /** A delivery that ran; a replay doesn't move its time, so the window ends when it should. */
  private remember(key: string) {
    this.db
      .query(
        `INSERT INTO hook_deliveries (key, seen_at) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET seen_at = excluded.seen_at WHERE seen_at <= ?`,
      )
      .run(key, this.now(), new Date(this.clock() - REPLAY_WINDOW_MS).toISOString());
  }

  /** Deliveries older than the window go, once a day. */
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
}

const newSecret = () => randomBytes(24).toString("base64url");

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * An Uptime Kuma alert in two parts: what Kuma itself says (the monitor, its type and address, the
 * status and the time), which is trusted, and its free-text message, which often quotes the monitored
 * service's own response, so anyone who can reach the service can write it (PLAN.md §6.1). Null for
 * anything that isn't an alert.
 */
export function alertParts(payload: string): { alert: string; message: string } | null {
  try {
    const { message, ...alert } = JSON.parse(payload) as Record<string, unknown>;
    if (typeof alert.monitor !== "string") return null;
    return {
      alert: JSON.stringify(alert, null, 2),
      message: typeof message === "string" ? message.trim() : "",
    };
  } catch {
    return null;
  }
}

/** What a task read when it read an alert's message. */
export const alertMessageSource = (monitor: string) => `The message in the alert for "${monitor}"`;

/** JSON indented for reading; anything else as it came. Cut to what a run gets to see. */
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
