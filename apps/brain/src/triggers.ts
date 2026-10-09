// Triggers (PLAN.md §4.1, §8): signed webhooks and Uptime Kuma alerts start background tasks.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { API_PREFIX, type Task, type Trigger, type TriggerWithSecret } from "@hatbot/shared";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { Notifier } from "./notify";
import type { SettingsStore } from "./settings";
import type { Tasks } from "./tasks/service";

/** How far a signed timestamp may be from now. */
const MAX_SKEW_S = 300;
/** Signatures seen this recently are replays. */
const REPLAY_WINDOW_MS = 24 * 3600_000;
/** What a run gets to see of a payload. */
const MAX_PAYLOAD_CHARS = 20_000;

type Row = {
  id: number;
  name: string;
  kind: Trigger["kind"];
  secret: string;
  trusted: number;
  prompt: string;
  enabled: number;
  created_at: string;
  last_fired_at: string | null;
  last_task_id: number | null;
};

const SELECT = `SELECT g.*, (SELECT max(id) FROM tasks t WHERE t.trigger_id = g.id) AS last_task_id
  FROM triggers g`;

export type Received =
  | { status: "started"; task: Task }
  | { status: "skipped"; reason: "paused" | "running" | "disabled" | "duplicate" | "ignored" }
  | { status: "test" };

/** Uptime Kuma's webhook body (its "Application/json" preset). */
type KumaBody = {
  heartbeat?: { status?: number; msg?: string; time?: string } | null;
  monitor?: { id?: number; name?: string; url?: string; hostname?: string; type?: string } | null;
  msg?: string;
};

export class Triggers {
  private seen = new Map<string, number>();
  private clock: () => number;

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
    url: `${this.publicUrl}${API_PREFIX}/hooks/${r.kind === "kuma" ? "kuma/" : ""}${r.id}`,
    createdAt: r.created_at,
    lastFiredAt: r.last_fired_at,
    lastTaskId: r.last_task_id,
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
  }): TriggerWithSecret {
    const secret = newSecret();
    const row = this.db
      .query<{ id: number }, [string, string, string, number, string, string]>(
        `INSERT INTO triggers (name, kind, secret, trusted, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(input.name, input.kind, secret, input.trusted ? 1 : 0, input.prompt, this.now());
    const trigger = this.changed(row?.id ?? -1) as Trigger;
    return { ...trigger, secret };
  }

  update(
    id: number,
    patch: { name?: string; prompt?: string; trusted?: boolean; enabled?: boolean },
  ): Trigger | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE g.id = ?`).get(id);
    if (!r) return null;
    this.db
      .query("UPDATE triggers SET name = ?, prompt = ?, trusted = ?, enabled = ? WHERE id = ?")
      .run(
        patch.name ?? r.name,
        patch.prompt ?? r.prompt,
        (patch.trusted ?? Boolean(r.trusted)) ? 1 : 0,
        (patch.enabled ?? Boolean(r.enabled)) ? 1 : 0,
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
    return { ok: true as const, replay: this.replayed(`${id}:${want}`) };
  }

  /** Uptime Kuma can't sign; it sends `Authorization: Bearer <secret>` from its Additional Headers. */
  verifyKuma(id: number, authorization: string | undefined): boolean {
    const secret = this.secretOf(id, "kuma");
    const got = authorization?.replace(/^Bearer\s+/i, "").trim();
    return Boolean(secret && got && same(got, secret));
  }

  /** A verified generic webhook: starts its run with the body as the payload. */
  receiveWebhook(id: number, body: string, replay: boolean): Received {
    const t = this.get(id);
    if (!t) return { status: "skipped", reason: "disabled" };
    if (replay) return { status: "skipped", reason: "duplicate" };
    this.fired(id);
    const blocked = this.blocked(t);
    if (blocked) return blocked;
    const task = this.tasks.createBackgroundTask({
      title: t.name,
      goal: t.prompt,
      origin: "webhook",
      source: t.name,
      triggerId: t.id,
      runKey: `trigger:${t.id}`,
      payload: pretty(body),
      trusted: t.trusted,
    });
    return task ? { status: "started", task } : { status: "skipped", reason: "running" };
  }

  /**
   * An Uptime Kuma event. "Down" starts an alert task per monitor; more alerts while it runs, and the
   * monitor coming back up, go on that task's timeline. Kuma's test message only marks the trigger as heard from.
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
    if (hb.status === 1) {
      if (active)
        this.tasks.addStep(active.id, {
          kind: "note",
          name: `${name} is back up`,
          detail: message,
          url: null,
        });
      return { status: "skipped", reason: "ignored" };
    }
    if (hb.status !== 0) return { status: "skipped", reason: "ignored" };
    if (active) {
      this.tasks.addStep(active.id, {
        kind: "note",
        name: `${name} is still down`,
        detail: message,
        url: null,
      });
      return { status: "skipped", reason: "running" };
    }
    const blocked = this.blocked(t);
    if (blocked) return blocked;
    const alert = {
      monitor: name,
      type: monitor.type,
      url: monitor.url,
      hostname: monitor.hostname,
      status: "down",
      message,
      time: hb.time,
    };
    const task = this.tasks.createBackgroundTask({
      title: `${name} is down`,
      goal: t.prompt,
      origin: "alert",
      source: t.name,
      triggerId: t.id,
      runKey,
      payload: JSON.stringify(alert, null, 2),
      trusted: true,
    });
    return task ? { status: "started", task } : { status: "skipped", reason: "running" };
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

  private replayed(key: string): boolean {
    const now = this.clock();
    for (const [k, until] of this.seen) if (until < now) this.seen.delete(k);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now + REPLAY_WINDOW_MS);
    return false;
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
