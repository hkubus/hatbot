import {
  type CreateWatcher,
  describeCondition,
  HATBOT_ID,
  minWatchMinutes,
  type UpdateWatcher,
  type WatchCondition,
  type Watcher,
  type WatcherValue,
  type WatchPreview,
  type WatchSource,
} from "@hatbot/shared";
import type { z } from "zod";
import type { Chats } from "../agent/chats";
import { tagJson } from "../agent/untrusted";
import { type Bots, orphaned } from "../bots";
import type { Db } from "../db";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import type { EventBus } from "../events";
import type { Notifier } from "../notify";
import { PluginError } from "../plugins/plugin";
import { type Plugins, untrustedOf } from "../plugins/registry";
import type { SettingsStore } from "../settings";
import type { Tasks } from "../tasks/service";
import { counts, pick, WatchError } from "./extract";

export { WatchError } from "./extract";

const PARALLEL = 4;
const TELL_AFTER_ERRORS = 5;
const KEEP_VALUES = 500;
const MAX_FIRES_PER_DAY = 12;
const BACKOFF_AFTER_ERRORS = 3;
const BACKOFF_MAX_MINUTES = 6 * 60;

export type WatchersDeps = {
  db: Db;
  events: EventBus;
  settings: SettingsStore;
  tasks: Tasks;
  chats: Chats;
  notifier: Notifier;
  desktop: DesktopAgent;
  plugins: Plugins;
  bots: Bots;
  publicUrl: string;
  clock?: () => number;
};

type Row = {
  id: number;
  bot_id: string;
  name: string;
  source: string;
  condition: string;
  prompt: string;
  every_minutes: number;
  once: number;
  enabled: number;
  created_via: Watcher["createdVia"];
  tainted: number;
  tainted_by: string | null;
  created_at: string;
  next_check_at: string | null;
  last_checked_at: string | null;
  last_value: string | null;
  last_changed_at: string | null;
  last_fired_at: string | null;
  last_error: string | null;
  errors: number;
  last_task_id: number | null;
};

const SELECT = `SELECT w.*, (SELECT max(id) FROM tasks t WHERE t.watcher_id = w.id) AS last_task_id
  FROM watchers w`;

const toWatcher = (r: Row): Watcher => ({
  id: r.id,
  botId: r.bot_id,
  name: r.name,
  source: JSON.parse(r.source),
  condition: JSON.parse(r.condition),
  prompt: r.prompt,
  everyMinutes: r.every_minutes,
  once: Boolean(r.once),
  enabled: Boolean(r.enabled),
  createdVia: r.created_via,
  tainted: Boolean(r.tainted),
  taintedBy: r.tainted_by,
  createdAt: r.created_at,
  nextCheckAt: r.next_check_at,
  lastCheckedAt: r.last_checked_at,
  lastValue: r.last_value,
  lastChangedAt: r.last_changed_at,
  lastFiredAt: r.last_fired_at,
  lastError: r.last_error,
  errors: r.errors,
  lastTaskId: r.last_task_id,
});

const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A source as it's kept: a switch that's off is left out, so it reads the same however it was saved. */
const saved = (s: WatchSource) => JSON.stringify({ ...s, render: s.render || undefined });

function oftenEnough(source: WatchSource, everyMinutes: number) {
  const min = minWatchMinutes(source);
  if (everyMinutes < min)
    throw new WatchError(
      `A watcher can't look more often than every ${min} minutes${source.render ? " when it runs the page's scripts" : ""}.`,
    );
}

export function describeSource(s: WatchSource): string {
  if (s.kind === "tool") return s.tool ?? "a tool";
  try {
    return new URL(s.url ?? "").host;
  } catch {
    return s.url ?? "a page";
  }
}

export class Watchers {
  private clock: () => number;
  private checking = new Set<number>();

  constructor(private d: WatchersDeps) {
    this.clock = d.clock ?? Date.now;
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private after(minutes: number) {
    return new Date(this.clock() + minutes * 60_000).toISOString();
  }

  list(): Watcher[] {
    return this.d.db.query<Row, []>(`${SELECT} ORDER BY w.name, w.id`).all().map(toWatcher);
  }

  get(id: number): Watcher | null {
    const r = this.d.db.query<Row, [number]>(`${SELECT} WHERE w.id = ?`).get(id);
    return r ? toWatcher(r) : null;
  }

  values(id: number, limit = 100): WatcherValue[] {
    return this.d.db
      .query<{ id: number; value: string; fired: number; created_at: string }, [number, number]>(
        "SELECT id, value, fired, created_at FROM watcher_values WHERE watcher_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(id, limit)
      .map((r) => ({ id: r.id, value: r.value, fired: Boolean(r.fired), createdAt: r.created_at }));
  }

  /**
   * Looks first, so a page that can't be read or a selector that matches nothing fails now rather
   * than on every check.
   */
  async create(
    input: z.output<typeof CreateWatcher>,
    via: "chat" | "owner",
    taintedBy: string | null = null,
  ): Promise<Watcher> {
    taintedBy = via === "chat" ? taintedBy : null;
    oftenEnough(input.source, input.everyMinutes);
    const first = await this.read(input.source, input.botId);
    const row = this.d.db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO watchers (bot_id, name, source, condition, prompt, every_minutes, once, enabled, created_via, tainted, tainted_by, created_at, next_check_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.botId,
        input.name,
        saved(input.source),
        JSON.stringify(input.condition),
        input.prompt,
        input.everyMinutes,
        input.once ? 1 : 0,
        input.enabled ? 1 : 0,
        via,
        taintedBy ? 1 : 0,
        taintedBy,
        this.now(),
        input.enabled ? this.after(input.everyMinutes) : null,
      );
    const id = row?.id ?? -1;
    // The first look counts too: "tell me when it's back in stock" when it already is.
    await this.saw(this.get(id) as Watcher, first.value, first.untrusted);
    return this.get(id) as Watcher;
  }

  // Your save clears the tainted mark; the chat's sets it when it had read untrusted content.
  async update(
    id: number,
    patch: z.output<typeof UpdateWatcher>,
    by: { via: "owner" } | { via: "chat"; taintedBy: string | null } = { via: "owner" },
  ): Promise<Watcher | null> {
    const w = this.get(id);
    if (!w) return null;
    const source = patch.source ?? w.source;
    const botId = patch.botId ?? w.botId;
    const every = patch.everyMinutes ?? w.everyMinutes;
    oftenEnough(source, every);
    const sourceChanged = patch.source && saved(patch.source) !== saved(w.source);
    const first = sourceChanged ? await this.read(source, botId) : null;
    const enabled = patch.enabled ?? w.enabled;
    // What it does or where it looks: yours to trust again.
    const rewritten = patch.prompt !== undefined || patch.source !== undefined;
    const tainted =
      by.via === "owner" ? !rewritten && w.tainted : Boolean(by.taintedBy) || w.tainted;
    const taintedBy = tainted
      ? w.tainted
        ? w.taintedBy
        : by.via === "chat"
          ? by.taintedBy
          : null
      : null;
    // Switched on again, or looking somewhere new: what it counted before doesn't hold it back.
    const recount = sourceChanged || (enabled && !w.enabled);
    const next = !enabled ? null : recount || every !== w.everyMinutes ? this.now() : w.nextCheckAt;
    this.d.db
      .query(
        `UPDATE watchers SET name = ?, bot_id = ?, source = ?, condition = ?, prompt = ?, every_minutes = ?, once = ?,
         enabled = ?, tainted = ?, tainted_by = ?, next_check_at = ?,
         last_value = CASE WHEN ? THEN NULL ELSE last_value END, errors = CASE WHEN ? THEN 0 ELSE errors END,
         last_error = CASE WHEN ? THEN NULL ELSE last_error END,
         counting_since = CASE WHEN ? THEN ? ELSE counting_since END WHERE id = ?`,
      )
      .run(
        patch.name ?? w.name,
        botId,
        saved(source),
        JSON.stringify(patch.condition ?? w.condition),
        patch.prompt ?? w.prompt,
        every,
        (patch.once ?? w.once) ? 1 : 0,
        enabled ? 1 : 0,
        tainted ? 1 : 0,
        taintedBy,
        next,
        // A new source starts from its own first value.
        sourceChanged ? 1 : 0,
        sourceChanged ? 1 : 0,
        recount ? 1 : 0,
        recount ? 1 : 0,
        this.now(),
        id,
      );
    // Null: deleted while its new source was read.
    const updated = this.get(id);
    if (!updated) return null;
    if (first) await this.saw(updated, first.value, first.untrusted);
    return this.changed(id);
  }

  trust(id: number): Watcher | null {
    this.d.db.query("UPDATE watchers SET tainted = 0, tainted_by = NULL WHERE id = ?").run(id);
    return this.changed(id);
  }

  delete(id: number): boolean {
    const gone = this.d.db.query("DELETE FROM watchers WHERE id = ?").run(id).changes > 0;
    if (gone) this.d.events.emit({ type: "watcher.deleted", id });
    return gone;
  }

  async preview(source: WatchSource, botId: string): Promise<WatchPreview> {
    try {
      return { ok: true, value: (await this.read(source, botId)).value };
    } catch (err) {
      if (err instanceof WatchError) return { ok: false, error: err.message };
      throw err;
    }
  }

  async checkNow(id: number): Promise<Watcher | null> {
    const w = this.get(id);
    if (!w) return null;
    await this.check(w);
    return this.get(id);
  }

  tick() {
    if (this.d.settings.get().paused) return;
    const due = this.d.db
      .query<Row, [string]>(
        `${SELECT} WHERE w.enabled = 1 AND w.next_check_at IS NOT NULL AND w.next_check_at <= ? ORDER BY w.next_check_at`,
      )
      .all(this.now())
      .map(toWatcher)
      .filter((w) => !this.checking.has(w.id));
    for (const w of due.slice(0, Math.max(0, PARALLEL - this.checking.size)))
      void this.check(w).catch((err) => console.error(`watcher ${w.id}: check failed`, err));
  }

  async idle() {
    while (this.checking.size) await Bun.sleep(5);
  }

  private async check(w: Watcher) {
    if (this.checking.has(w.id)) return;
    if (orphaned(this.d.db, "watchers", w.id, w.botId)) {
      this.changed(w.id);
      return;
    }
    this.checking.add(w.id);
    try {
      // The next check counts from this one, so an outage doesn't queue up a check per missed time.
      this.d.db
        .query("UPDATE watchers SET next_check_at = ? WHERE id = ? AND enabled = 1")
        .run(this.after(Math.max(minWatchMinutes(w.source), w.everyMinutes)), w.id);
      let found: { value: string; untrusted: boolean };
      try {
        found = await this.read(w.source, w.botId);
      } catch (err) {
        if (!(err instanceof WatchError)) console.error(`watcher ${w.id} failed`, err);
        this.failed(w, err instanceof WatchError ? err.message : "It failed; see the brain's log.");
        return;
      }
      await this.saw(w, found.value, found.untrusted);
    } finally {
      this.checking.delete(w.id);
    }
  }

  private failed(seen: Watcher, error: string) {
    const w = this.still(seen);
    if (!w) return;
    const errors = w.errors + 1;
    const every = Math.max(minWatchMinutes(w.source), w.everyMinutes);
    const doubled = every * 2 ** (errors - BACKOFF_AFTER_ERRORS + 1);
    const wait = Math.max(every, Math.min(BACKOFF_MAX_MINUTES, doubled));
    this.d.db
      .query(
        `UPDATE watchers SET last_checked_at = ?, last_error = ?, errors = ?,
         next_check_at = CASE WHEN enabled = 1 THEN ? ELSE next_check_at END WHERE id = ?`,
      )
      .run(this.now(), error, errors, this.after(wait), w.id);
    this.changed(w.id);
    if (errors === TELL_AFTER_ERRORS)
      void this.d.notifier.send({
        title: this.titled(w, `Can't check ${w.name}`),
        message: `It has failed ${errors} times in a row: ${error}`,
        priority: 3,
        click: `${this.d.publicUrl}/watchers/${w.id}`,
      });
  }

  private async saw(seen: Watcher, value: string, untrusted: boolean) {
    const w = this.still(seen);
    if (!w) return;
    const previous = w.lastValue;
    const fired = counts(w.condition, previous, value);
    const now = this.now();
    if (previous !== value) {
      this.d.db
        .query(
          "INSERT INTO watcher_values (watcher_id, value, fired, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(w.id, value, fired ? 1 : 0, now);
      this.d.db
        .query(
          `DELETE FROM watcher_values WHERE watcher_id = ? AND id NOT IN
           (SELECT id FROM watcher_values WHERE watcher_id = ? ORDER BY id DESC LIMIT ?)`,
        )
        .run(w.id, w.id, KEEP_VALUES);
    }
    const off = fired && w.once;
    this.d.db
      .query(
        `UPDATE watchers SET last_checked_at = ?, last_value = ?, errors = 0, last_error = NULL,
         last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END,
         last_fired_at = CASE WHEN ? THEN ? ELSE last_fired_at END,
         enabled = CASE WHEN ? THEN 0 ELSE enabled END, next_check_at = CASE WHEN ? THEN NULL ELSE next_check_at END
         WHERE id = ?`,
      )
      .run(
        now,
        value,
        previous !== value ? 1 : 0,
        now,
        fired ? 1 : 0,
        now,
        off ? 1 : 0,
        off ? 1 : 0,
        w.id,
      );
    if (fired && this.firedToday(w.id) > MAX_FIRES_PER_DAY) return this.tooOften(w);
    this.changed(w.id);
    if (fired) this.fire(w, previous, value, untrusted);
  }

  /** The watcher as it is now, or null if it was deleted or given a new source while it was read. */
  private still(seen: Watcher): Watcher | null {
    const w = this.get(seen.id);
    return w && saved(w.source) === saved(seen.source) ? w : null;
  }

  private firedToday(id: number): number {
    return (
      this.d.db
        .query<{ n: number }, [number, string]>(
          `SELECT count(*) AS n FROM watcher_values v JOIN watchers w ON w.id = v.watcher_id
           WHERE v.watcher_id = ? AND v.fired = 1 AND v.created_at > ?
           AND v.created_at >= coalesce(w.counting_since, '')`,
        )
        .get(id, new Date(this.clock() - 86400_000).toISOString())?.n ?? 0
    );
  }

  private tooOften(w: Watcher) {
    const why = `It counted more than ${MAX_FIRES_PER_DAY} times in a day, so it was switched off.`;
    this.d.db
      .query("UPDATE watchers SET enabled = 0, next_check_at = NULL, last_error = ? WHERE id = ?")
      .run(why, w.id);
    this.changed(w.id);
    void this.d.notifier.send({
      title: this.titled(w, `${w.name} is off`),
      message: `${why} Narrow what it looks at, then switch it back on.`,
      priority: 3,
      click: `${this.d.publicUrl}/watchers/${w.id}`,
    });
  }

  private fire(w: Watcher, previous: string | null, value: string, untrusted: boolean) {
    if (orphaned(this.d.db, "watchers", w.id, w.botId)) {
      this.changed(w.id);
      return;
    }
    const change =
      previous === null
        ? `Now: ${value}`
        : `Was: ${short(previous, 1500)}\nNow: ${short(value, 1500)}`;
    if (w.prompt) {
      const task = this.d.tasks.createBackgroundTask({
        title: w.name,
        goal: w.prompt,
        origin: "watch",
        source: w.name,
        watcherId: w.id,
        botId: w.botId,
        runKey: `watch:${w.id}`,
        payload: `The watcher "${w.name}" (${describeSource(w.source)}, when it ${describeCondition(w.condition).toLowerCase()}) saw:\n${change}`,
        trusted: !untrusted,
        taintedBy: w.tainted
          ? `Its watcher, which the chat wrote after reading: ${w.taintedBy ?? "untrusted content"}`
          : null,
      });
      if (task) return;
      console.log(`watcher ${w.id} "${w.name}": its last task is still going`);
    }
    const what = previous === null ? short(value) : `${short(previous, 120)} → ${short(value)}`;
    // What a page said, or a name the chat wrote after reading one, isn't the bot's own words.
    const from = untrusted
      ? `What the watcher "${w.name}" saw`
      : w.tainted
        ? `The watcher "${w.name}", made after reading: ${w.taintedBy ?? "untrusted content"}`
        : null;
    this.d.chats.note(w.botId, `**${w.name}**: ${what}`, from);
    void this.d.notifier.send({
      title: this.titled(w, w.name),
      message: what,
      priority: 4,
      click: `${this.d.publicUrl}/watchers/${w.id}`,
    });
  }

  private titled(w: Watcher, title: string) {
    return (w.botId === HATBOT_ID ? title : `${this.d.bots.nameOf(w.botId)} · ${title}`).slice(
      0,
      120,
    );
  }

  private async read(
    source: WatchSource,
    botId: string,
  ): Promise<{ value: string; untrusted: boolean }> {
    if (source.kind === "page") {
      if (!this.d.desktop.configured)
        throw new WatchError("Pages are fetched from the desktop, which isn't set up.");
      if (source.render && source.path)
        throw new WatchError(
          "A JSON path can't be used when the page's scripts run: the page comes back as HTML. Use a selector or a pattern.",
        );
      let body: string;
      let contentType: string;
      try {
        if (source.render) {
          body = (await this.d.desktop.render(source.url ?? "")).html;
          contentType = "text/html";
        } else {
          const r = await this.d.desktop.fetch(source.url ?? "");
          if (r.status >= 400) throw new WatchError(`The page answered ${r.status}.`);
          ({ body, contentType } = r);
        }
      } catch (err) {
        if (err instanceof DesktopError) throw new WatchError(err.message);
        throw err;
      }
      // Web pages are written by strangers, and so are their scripts.
      return { value: await pick(body, contentType, source), untrusted: true };
    }
    const bot = this.d.bots.get(botId) ?? this.d.bots.hatbot();
    const t = this.d.plugins.tools(bot.plugins).find((x) => x.name === source.tool);
    if (!t)
      throw new WatchError(
        `${bot.name} has no tool called ${source.tool}: its plugin is off, or not one ${bot.name} may use.`,
      );
    if (t.access !== "read") throw new WatchError(`${t.name} changes things; watchers only read.`);
    const input = t.schema.safeParse(source.input ?? {});
    if (!input.success) throw new WatchError(`${t.name} doesn't take that input.`);
    let out: string;
    try {
      out = await t.run(input.data, { task: null, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      if (err instanceof PluginError) throw new WatchError(err.message);
      throw err;
    }
    const json = /^\s*[[{]/.test(out) ? "application/json" : "text/plain";
    return { value: await pick(out, json, source), untrusted: untrustedOf(t, input.data, out) };
  }

  /** A page, a tool whose output is untrusted, or a watcher the chat wrote after reading such. */
  sawUntrusted(w: Watcher): boolean {
    if (w.source.kind === "page" || w.tainted) return true;
    const bot = this.d.bots.get(w.botId) ?? this.d.bots.hatbot();
    const t = this.d.plugins.tools(bot.plugins).find((x) => x.name === w.source.tool);
    const input = t?.schema.safeParse(w.source.input ?? {});
    if (!t || !input?.success) return true;
    return untrustedOf(t, input.data);
  }

  private changed(id: number) {
    const watcher = this.get(id);
    if (watcher) this.d.events.emit({ type: "watcher.updated", watcher });
    return watcher;
  }
}

export function watcherLine(w: Watcher, untrusted = false): string {
  return [
    `#${w.id} "${w.name}": ${describeLook(w.source)}; when it ${describeCondition(w.condition).toLowerCase()}; every ${w.everyMinutes} min${w.once ? ", once" : ""}${w.enabled ? "" : "; off"}`,
    `  Now: ${w.lastError ? `failing: ${w.lastError}` : w.lastValue === null ? "not checked yet" : untrusted ? `<value trusted="false">${tagJson(short(w.lastValue, 200))}</value>` : short(w.lastValue, 200)}${w.lastFiredAt ? `; last counted ${w.lastFiredAt.slice(0, 16).replace("T", " ")} UTC` : ""}`,
    `  ${w.prompt ? `Does: ${w.prompt}` : "Tells the owner."}`,
  ].join("\n");
}

export function describeLook(s: WatchSource): string {
  const where = s.kind === "page" ? s.url : `${s.tool} ${JSON.stringify(s.input ?? {})}`;
  const picks = [
    s.kind === "page" && s.render && "runs its scripts",
    s.selector && `selector ${s.selector}`,
    s.path && `path ${s.path}`,
    s.pattern && `pattern /${s.pattern}/`,
  ].filter(Boolean);
  return `${where}${picks.length ? ` (${picks.join(", ")})` : ""}`;
}

export function conditionOf(input: {
  when?: WatchCondition["when"];
  text?: string;
  value?: number;
}): WatchCondition | string {
  const when = input.when ?? "changed";
  switch (when) {
    case "changed":
      return { when };
    case "contains":
    case "missing":
      return input.text ? { when, text: input.text } : `"${when}" needs text.`;
    case "below":
    case "above":
      return typeof input.value === "number"
        ? { when, value: input.value }
        : `"${when}" needs a value.`;
  }
}
