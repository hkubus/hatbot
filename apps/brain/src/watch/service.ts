// Watchers: a page or a plugin's value, looked at on a timer without the model. Only a change that
// counts tells you or starts a bot's task, so watching costs nothing until something happens.
import {
  type CreateWatcher,
  describeCondition,
  HATBOT_ID,
  MAX_WATCH_MINUTES,
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
import { type Bots, liveBot } from "../bots";
import type { Db } from "../db";
import { type DesktopAgent, DesktopError } from "../desktop/client";
import type { EventBus } from "../events";
import type { Notifier } from "../notify";
import { PluginError } from "../plugins/plugin";
import type { Plugins } from "../plugins/registry";
import type { SettingsStore } from "../settings";
import type { Tasks } from "../tasks/service";
import { counts, pick, WatchError } from "./extract";

export { WatchError } from "./extract";

/** Checks running at once. */
const PARALLEL = 4;
/** Failed checks in a row before you're told, once. */
const TELL_AFTER_ERRORS = 5;
/** Values kept per watcher. */
const KEEP_VALUES = 500;
/** Times a watcher may count in a day; more and it's switched off, as a page that changes on every look. */
const MAX_FIRES_PER_DAY = 12;
/** From this many failed checks in a row, each wait doubles, up to BACKOFF_MAX_MINUTES. */
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

/** "€1,299" → "€1,099", cut short for a notification. */
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A source as it's kept: a switch that's off is left out, so it reads the same however it was saved. */
const saved = (s: WatchSource) => JSON.stringify({ ...s, render: s.render || undefined });

/** Throws when a watcher would look more often than its source allows. */
function oftenEnough(source: WatchSource, everyMinutes: number) {
  if (everyMinutes > MAX_WATCH_MINUTES)
    throw new WatchError("A watcher looks at least once a week.");
  const min = minWatchMinutes(source);
  if (everyMinutes < min)
    throw new WatchError(
      `A watcher can't look more often than every ${min} minutes${source.render ? " when it runs the page's scripts" : ""}.`,
    );
}

/** Where a watcher looks, in a few words: the page's host, or the tool. */
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

  /** The values it saw, newest first. */
  values(id: number, limit = 100): WatcherValue[] {
    return this.d.db
      .query<{ id: number; value: string; fired: number; created_at: string }, [number, number]>(
        "SELECT id, value, fired, created_at FROM watcher_values WHERE watcher_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(id, limit)
      .map((r) => ({ id: r.id, value: r.value, fired: Boolean(r.fired), createdAt: r.created_at }));
  }

  /**
   * Makes a watcher after a first look, so a page that can't be read or a selector that matches nothing
   * is said now rather than on every check. That look is the first value. Throws WatchError.
   */
  async create(
    input: z.output<typeof CreateWatcher>,
    via: "chat" | "owner",
    /** What the chat had read, when it had read untrusted content. */
    taintedBy: string | null = null,
  ): Promise<Watcher> {
    taintedBy = via === "chat" ? taintedBy : null;
    oftenEnough(input.source, input.everyMinutes);
    const first = await this.read(input.source, input.botId);
    const row = this.d.db
      .query<
        { id: number },
        [
          string,
          string,
          string,
          string,
          string,
          number,
          number,
          number,
          string,
          number,
          string | null,
          string,
          string | null,
        ]
      >(
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

  /**
   * `by`: you (saving it clears the tainted mark), or the chat (`taintedBy`: what untrusted content it
   * had read, which sets it). A new source is looked at first. Throws WatchError.
   */
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
    const next = !enabled
      ? null
      : sourceChanged || (enabled && !w.enabled) || every !== w.everyMinutes
        ? this.now()
        : w.nextCheckAt;
    // Switched on again, or looking somewhere new: what it counted before doesn't hold it back.
    const recount = sourceChanged || (enabled && !w.enabled);
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
    // Like a new watcher, that look is its first value.
    if (first) await this.saw(this.get(id) as Watcher, first.value, first.untrusted);
    return this.changed(id);
  }

  delete(id: number): boolean {
    const gone = this.d.db.query("DELETE FROM watchers WHERE id = ?").run(id).changes > 0;
    if (gone) this.d.events.emit({ type: "watcher.deleted", id });
    return gone;
  }

  /** What a check would find now, without saving it: the form's Try button. */
  async preview(source: WatchSource, botId: string): Promise<WatchPreview> {
    try {
      return { ok: true, value: (await this.read(source, botId)).value };
    } catch (err) {
      if (err instanceof WatchError) return { ok: false, error: err.message };
      throw err;
    }
  }

  /** Looks now, outside its timer. */
  async checkNow(id: number): Promise<Watcher | null> {
    const w = this.get(id);
    if (!w) return null;
    await this.check(w);
    return this.get(id);
  }

  /** Starts the checks that are due; the brain calls it every few seconds. */
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

  /** Waits for the checks in flight (tests). */
  async idle() {
    while (this.checking.size) await Bun.sleep(5);
  }

  private async check(w: Watcher) {
    if (this.checking.has(w.id)) return;
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

  private failed(w: Watcher, error: string) {
    const errors = w.errors + 1;
    // One that keeps failing looks less often: each wait twice the last, up to six hours.
    const every = Math.max(minWatchMinutes(w.source), w.everyMinutes);
    const wait =
      errors < BACKOFF_AFTER_ERRORS
        ? every
        : Math.max(
            every,
            Math.min(BACKOFF_MAX_MINUTES, every * 2 ** (errors - BACKOFF_AFTER_ERRORS + 1)),
          );
    const updated = this.d.db
      .query(
        `UPDATE watchers SET last_checked_at = ?, last_error = ?, errors = ?,
         next_check_at = CASE WHEN enabled = 1 THEN ? ELSE next_check_at END WHERE id = ?`,
      )
      .run(this.now(), error, errors, this.after(wait), w.id).changes;
    // Deleted while it was being read.
    if (!updated) return;
    this.changed(w.id);
    if (errors === TELL_AFTER_ERRORS)
      void this.d.notifier.send({
        title: this.titled(w, `Can't check ${w.name}`),
        message: `It has failed ${errors} times in a row: ${error}`,
        priority: 3,
        click: `${this.d.publicUrl}/watchers/${w.id}`,
      });
  }

  /** A value it found: kept if it's new, and acted on if it counts. */
  private async saw(seen: Watcher, value: string, untrusted: boolean) {
    // As it is now: it may have been deleted, or given a new source, while its page was read.
    const w = this.get(seen.id);
    if (!w || saved(w.source) !== saved(seen.source)) return;
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

  /** Times it counted in the last 24 hours, since it was last switched on or given a new source. */
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

  /** Counted more often than anyone wants to hear: switched off, and you're told once. */
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

  /** It counted: you're told, or its bot works on it. */
  private fire(watcher: Watcher, previous: string | null, value: string, untrusted: boolean) {
    const w = { ...watcher, botId: liveBot(this.d.db, watcher.botId) };
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

  /** Fetches or calls the source and picks the value out. Throws WatchError. */
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
      // Web pages are written by strangers (PLAN.md §6.1), and so are their scripts.
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
    const untrusted =
      typeof t.untrusted === "function" ? t.untrusted(input.data) : Boolean(t.untrusted);
    const json = /^\s*[[{]/.test(out) ? "application/json" : "text/plain";
    return { value: await pick(out, json, source), untrusted };
  }

  /**
   * Whether what it saw came from untrusted content (PLAN.md §6.1): a page, a tool whose output is, or
   * a watcher the chat wrote after reading some.
   */
  sawUntrusted(w: Watcher): boolean {
    if (w.source.kind === "page" || w.tainted) return true;
    const bot = this.d.bots.get(w.botId) ?? this.d.bots.hatbot();
    const t = this.d.plugins.tools(bot.plugins).find((x) => x.name === w.source.tool);
    const input = t?.schema.safeParse(w.source.input ?? {});
    if (!t || !input?.success) return true;
    return typeof t.untrusted === "function" ? t.untrusted(input.data) : Boolean(t.untrusted);
  }

  private changed(id: number) {
    const watcher = this.get(id);
    if (watcher) this.d.events.emit({ type: "watcher.updated", watcher });
    return watcher;
  }
}

/** A watcher in a line or two, for the chat's tools. What an untrusted source said is quoted as data. */
export function watcherLine(w: Watcher, untrusted = false): string {
  return [
    `#${w.id} "${w.name}": ${describeLook(w.source)}; when it ${describeCondition(w.condition).toLowerCase()}; every ${w.everyMinutes} min${w.once ? ", once" : ""}${w.enabled ? "" : "; off"}`,
    `  Now: ${w.lastError ? `failing: ${w.lastError}` : w.lastValue === null ? "not checked yet" : untrusted ? `<value trusted="false">${tagJson(short(w.lastValue, 200))}</value>` : short(w.lastValue, 200)}${w.lastFiredAt ? `; last counted ${w.lastFiredAt.slice(0, 16).replace("T", " ")} UTC` : ""}`,
    `  ${w.prompt ? `Does: ${w.prompt}` : "Tells the owner."}`,
  ].join("\n");
}

/** What a watcher looks at, and what it picks out of it. */
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

/** Its condition, from the chat tools' flat fields. */
export function conditionOf(input: {
  when?: string;
  text?: string;
  value?: number;
}): WatchCondition | string {
  switch (input.when ?? "changed") {
    case "changed":
      return { when: "changed" };
    case "contains":
    case "missing":
      return input.text
        ? { when: input.when as "contains" | "missing", text: input.text }
        : `"${input.when}" needs text.`;
    case "below":
    case "above":
      return typeof input.value === "number"
        ? { when: input.when as "below" | "above", value: input.value }
        : `"${input.when}" needs a value.`;
    default:
      return `Unknown condition "${input.when}".`;
  }
}
