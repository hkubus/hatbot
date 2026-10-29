import type { ModelPrice } from "@hatbot/plugin-sdk";
import { BudgetError } from "@hatbot/plugin-sdk";
import type { SpendByPurpose } from "@hatbot/shared";
import type { Db } from "./db";
import type { EventBus } from "./events";
import { modelInfo } from "./models-known";
import type { SettingsStore } from "./settings";

export type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
};

export type Tokens = {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
};

export function tokensOf(u: UsageLike): Tokens {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m =
    u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - write1h;
  return {
    input: u.input_tokens,
    cacheWrite5m: Math.max(0, write5m),
    cacheWrite1h: write1h,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
  };
}

// Unknown models get the highest rates (Claude Fable's), so spend is never under-counted.
const UNKNOWN_PRICE: ModelPrice = { input: 10, output: 50, cacheRead: 1 };
const unpriced = new Set<string>();

export function priceOf(model: string) {
  const p = modelInfo(model)?.price;
  if (p) return p;
  if (!unpriced.has(model)) {
    unpriced.add(model);
    console.warn(`no price for model ${model}; it's billed at the highest rates`);
  }
  return UNKNOWN_PRICE;
}

export function costOf(model: string, t: Tokens): number {
  const base = priceOf(model);
  const prompt = t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
  const p = base.longPrompt && prompt > base.longPrompt.above ? base.longPrompt : base;
  return (
    (t.input * p.input +
      t.cacheWrite5m * p.input * 1.25 +
      t.cacheWrite1h * p.input * 2 +
      t.cacheRead * p.cacheRead +
      t.output * p.output) /
    1_000_000
  );
}

export const searchesIn = (tools: readonly unknown[]) =>
  tools.reduce<number>((n, t) => {
    const tool = t as { name?: string; max_uses?: number };
    return n + (tool.name === "web_search" ? (tool.max_uses ?? 0) : 0);
  }, 0);

/**
 * The most one request may cost. With `fallbacks`, a model that declines partway is billed for what
 * it read, then a fallback model answers at its own rates with nothing cached.
 */
export function requestCeiling(
  model: string,
  r: {
    prompt: number;
    /** Of those, ones the last request left in the cache, still within its TTL. */
    cached?: number;
    write?: "5m" | "1h";
    maxTokens: number;
    webSearches?: number;
    fallbacks?: boolean;
  },
): number {
  const ceiling = (m: string, cachedTokens: number, output: number) => {
    const cached = Math.min(cachedTokens, r.prompt);
    const fresh = r.prompt - cached;
    return costOf(m, {
      input: r.write ? 0 : fresh,
      cacheWrite5m: r.write === "5m" ? fresh : 0,
      cacheWrite1h: r.write === "1h" ? fresh : 0,
      cacheRead: cached,
      output,
    });
  };
  const searches = (r.webSearches ?? 0) * WEB_SEARCH_USD;
  const own = ceiling(model, r.cached ?? 0, r.maxTokens);
  const others = r.fallbacks ? (modelInfo(model)?.fallbacks?.map((f) => f.id) ?? []) : [];
  if (!others.length) return own + searches;
  const declined = ceiling(model, r.cached ?? 0, 0);
  const rescue = Math.max(...others.map((m) => ceiling(m, 0, r.maxTokens)));
  return Math.max(own, declined + rescue) + searches;
}

const TOKENS =
  "input_tokens + cache_write_5m_tokens + cache_write_1h_tokens + cache_read_tokens + output_tokens";

export const tokenCount = (t: Tokens) =>
  t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output;

const startOfLocalDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};
const startOfLocalMonth = (ms: number) => {
  const d = startOfLocalDay(ms);
  d.setDate(1);
  return d;
};
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const WEB_SEARCH_USD = 0.01;

export class Spend {
  private held = new Map<symbol, { usd: number; root?: number }>();
  /** Today's and the month's spend, brought up to date from the rows added since, not summed again. */
  private totals = { day: "", month: "", lastId: 0, todayUsd: 0, monthUsd: 0 };

  constructor(
    private db: Db,
    private settings: SettingsStore,
    private events: EventBus,
    private clock: () => number = Date.now,
  ) {}

  record(entry: {
    model: string;
    purpose: string;
    usage: UsageLike;
    episodeId?: number;
    taskId?: number;
    /** The bot it was for; a task's when left out. */
    botId?: string;
    extraUsd?: number;
  }): number {
    const t = tokensOf(entry.usage);
    const cost = costOf(entry.model, t) + (entry.extraUsd ?? 0);
    this.db
      .query(
        `INSERT INTO spend_ledger (created_at, model, purpose, episode_id, task_id, bot_id, input_tokens, cache_write_5m_tokens,
           cache_write_1h_tokens, cache_read_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, coalesce(?, (SELECT bot_id FROM tasks WHERE id = ?)), ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date(this.clock()).toISOString(),
        entry.model,
        entry.purpose,
        entry.episodeId ?? null,
        entry.taskId ?? null,
        entry.botId ?? null,
        entry.taskId ?? null,
        t.input,
        t.cacheWrite5m,
        t.cacheWrite1h,
        t.cacheRead,
        t.output,
        cost,
      );
    const { todayUsd, monthUsd } = this.spent();
    this.events.emit({ type: "spend.updated", todayUsd, monthUsd });
    return cost;
  }

  /**
   * Records one API response. With server-side fallback, usage.iterations lists each model that ran,
   * and each is billed at its own rates.
   */
  recordResponse(entry: {
    model: string;
    purpose: string;
    usage: UsageLike & {
      iterations?: ({ model?: string | null } & UsageLike)[] | null;
      server_tool_use?: { web_search_requests?: number } | null;
    };
    episodeId?: number;
    taskId?: number;
    botId?: string;
  }): number {
    const parts = entry.usage.iterations?.length ? entry.usage.iterations : [entry.usage];
    // Web searches cost $10 per 1,000 on top of tokens; they go on the first part.
    let extraUsd = (entry.usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
    let total = 0;
    for (const part of parts) {
      const model = "model" in part && part.model ? part.model : entry.model;
      total += this.record({ ...entry, model, usage: part, extraUsd });
      extraUsd = 0;
    }
    return total;
  }

  private windowSince(since: Date): { usd: number; tokens: number } {
    const row = this.db
      .query<{ usd: number | null; tokens: number | null }, [string]>(
        `SELECT sum(cost_usd) AS usd, sum(${TOKENS}) AS tokens FROM spend_ledger WHERE created_at >= ?`,
      )
      .get(since.toISOString());
    return { usd: row?.usd ?? 0, tokens: row?.tokens ?? 0 };
  }

  hourly(hours: number): { hour: string; usd: number; tokens: number }[] {
    const start = new Date(this.clock());
    start.setMinutes(0, 0, 0);
    start.setTime(start.getTime() - (hours - 1) * 3600_000);
    const rows = this.db
      .query<{ created_at: string; cost_usd: number; tokens: number }, [string]>(
        `SELECT created_at, cost_usd, ${TOKENS} AS tokens FROM spend_ledger WHERE created_at >= ?`,
      )
      .all(start.toISOString());
    const out = Array.from({ length: hours }, (_, i) => ({
      hour: new Date(start.getTime() + i * 3600_000).toISOString(),
      usd: 0,
      tokens: 0,
    }));
    for (const r of rows) {
      const slot = out[Math.floor((Date.parse(r.created_at) - start.getTime()) / 3600_000)];
      if (!slot) continue;
      slot.usd += r.cost_usd;
      slot.tokens += r.tokens;
    }
    return out;
  }

  private spent(): { todayUsd: number; monthUsd: number } {
    const now = this.clock();
    const day = startOfLocalDay(now).toISOString();
    const month = startOfLocalMonth(now).toISOString();
    const t = this.totals;
    if (t.day !== day || t.month !== month) {
      const row = this.db
        .query<
          { today: number | null; month: number | null; last: number | null },
          [string, string]
        >(
          `SELECT sum(CASE WHEN created_at >= ?1 THEN cost_usd END) AS today, sum(cost_usd) AS month,
           (SELECT max(id) FROM spend_ledger) AS last FROM spend_ledger WHERE created_at >= ?2`,
        )
        .get(day, month);
      this.totals = {
        day,
        month,
        lastId: row?.last ?? 0,
        todayUsd: row?.today ?? 0,
        monthUsd: row?.month ?? 0,
      };
    } else {
      const row = this.db
        .query<
          { today: number | null; month: number | null; last: number | null },
          [string, string, number]
        >(
          `SELECT sum(CASE WHEN created_at >= ?1 THEN cost_usd END) AS today,
           sum(CASE WHEN created_at >= ?2 THEN cost_usd END) AS month, max(id) AS last
           FROM spend_ledger WHERE id > ?3`,
        )
        .get(day, month, t.lastId);
      if (row?.last) {
        t.lastId = row.last;
        t.todayUsd += row.today ?? 0;
        t.monthUsd += row.month ?? 0;
      }
    }
    return { todayUsd: this.totals.todayUsd, monthUsd: this.totals.monthUsd };
  }

  summary() {
    const now = this.clock();
    const today = this.windowSince(startOfLocalDay(now));
    return {
      todayUsd: today.usd,
      monthUsd: this.spent().monthUsd,
      limits: this.settings.get().limits,
      todayTokens: today.tokens,
      lastHour: this.windowSince(new Date(now - 3600_000)),
      lastMinute: this.windowSince(new Date(now - 60_000)),
    };
  }

  treeSpend(taskId: number): number {
    return this.tree(taskId).usd;
  }

  /**
   * A task's tree (the task that started it and every task under that one) shares its limit. A task
   * the ledger knows but the tasks table doesn't is on its own.
   */
  private tree(taskId: number): { root: number; usd: number } {
    const row = this.db
      .query<{ root: number | null; usd: number | null }, [number]>(
        `WITH RECURSIVE up(id, parent) AS (
           SELECT id, parent_id FROM tasks WHERE id = ?1
           UNION ALL SELECT t.id, t.parent_id FROM tasks t JOIN up ON t.id = up.parent),
         tree(id) AS (
           SELECT id FROM up WHERE parent IS NULL
           UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
         SELECT coalesce((SELECT id FROM up WHERE parent IS NULL), ?1) AS root,
           (SELECT sum(cost_usd) FROM spend_ledger WHERE task_id IN (SELECT id FROM tree UNION SELECT ?1)) AS usd`,
      )
      .get(taskId);
    return { root: row?.root ?? taskId, usd: row?.usd ?? 0 };
  }

  /**
   * Throws BudgetError if a request would cross a limit, counting what requests in flight may still
   * cost. Only `reserve` work may spend the last `alertReserveUsd` of the daily and monthly limits.
   */
  check(estimateUsd: number, task?: { id: number; limitUsd: number }, { reserve = false } = {}) {
    const limits = this.settings.get().limits;
    const { todayUsd, monthUsd } = this.spent();
    const tree = task ? this.tree(task.id) : null;
    let inFlight = 0;
    let taskInFlight = 0;
    for (const h of this.held.values()) {
      inFlight += h.usd;
      if (tree && h.root === tree.root) taskInFlight += h.usd;
    }
    if (task && tree && tree.usd + taskInFlight + estimateUsd > task.limitUsd) {
      throw new BudgetError(
        "task",
        tree.root === task.id
          ? `This task would go over its $${task.limitUsd} limit.`
          : `This task would take task #${tree.root}, which started it, over its $${task.limitUsd} limit.`,
      );
    }
    const need = estimateUsd + inFlight;
    const kept = reserve ? 0 : limits.alertReserveUsd;
    const why = (spent: number, limit: number) =>
      spent + need > limit ? "" : ` (its last $${kept} is kept for alerts)`;
    if (todayUsd + need > limits.dailyUsd - kept) {
      throw new BudgetError(
        "daily",
        `Today's $${limits.dailyUsd} limit would be exceeded${why(todayUsd, limits.dailyUsd)}.`,
      );
    }
    if (monthUsd + need > limits.monthlyUsd - kept) {
      throw new BudgetError(
        "monthly",
        `This month's $${limits.monthlyUsd} limit would be exceeded${why(monthUsd, limits.monthlyUsd)}.`,
      );
    }
    return tree?.root;
  }

  /**
   * Holds the estimate while the request is in flight, so requests made at once can't pass a limit
   * together. Call what it returns once the cost is recorded.
   */
  hold(
    estimateUsd: number,
    task?: { id: number; limitUsd: number },
    opts?: { reserve?: boolean },
  ): () => void {
    const root = this.check(estimateUsd, task, opts);
    const key = Symbol();
    this.held.set(key, { usd: estimateUsd, root });
    return () => {
      this.held.delete(key);
    };
  }

  byModel(days: number) {
    return this.breakdown<{ model: string; usd: number }>("model, sum(cost_usd) AS usd", days);
  }

  byPurpose(days: number) {
    return this.breakdown<SpendByPurpose>("purpose, sum(cost_usd) AS costUsd", days);
  }

  byBot(days: number) {
    return this.breakdown<{ botId: string; usd: number }>(
      "coalesce(bot_id, 'hatbot') AS botId, sum(cost_usd) AS usd",
      days,
    );
  }

  private breakdown<T>(columns: string, days: number): T[] {
    const from = startOfLocalDay(this.clock() - (days - 1) * 86400_000);
    return this.db
      .query<T, [string]>(
        `SELECT ${columns} FROM spend_ledger WHERE created_at >= ? GROUP BY 1 ORDER BY 2 DESC`,
      )
      .all(from.toISOString());
  }

  daily(days: number): { date: string; usd: number }[] {
    const now = this.clock();
    const from = startOfLocalDay(now - (days - 1) * 86400_000);
    const rows = this.db
      .query<{ created_at: string; cost_usd: number }, [string]>(
        "SELECT created_at, cost_usd FROM spend_ledger WHERE created_at >= ?",
      )
      .all(from.toISOString());
    const byDay = new Map<string, number>();
    for (const d = new Date(from); byDay.size < days; d.setDate(d.getDate() + 1))
      byDay.set(localDate(d), 0);
    for (const r of rows) {
      const key = localDate(new Date(r.created_at));
      byDay.set(key, (byDay.get(key) ?? 0) + r.cost_usd);
    }
    return [...byDay].map(([date, usd]) => ({ date, usd }));
  }
}
