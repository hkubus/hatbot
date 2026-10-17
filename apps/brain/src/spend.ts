// Spend ledger and limits (PLAN.md §6.3).
import type { SpendByPurpose } from "@hatbot/shared";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { SettingsStore } from "./settings";

type Price = { input: number; output: number; cacheRead: number };

/**
 * USD per million tokens. Cache writes are priced from input: 1.25x for 5 minutes, 2x for 1 hour.
 * `longPrompt`: above that many prompt tokens (input + cache reads and writes), the whole request
 * is billed at the higher price.
 */
export const PRICES: Record<string, Price & { longPrompt?: { above: number } & Price }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  // What a declined Opus 5.5 request may be answered by (FALLBACK_MODELS).
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  // Haiku 5.5's long-prompt cache-read price isn't published separately; assumed 5x like the rest.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  // Older rows in the ledger.
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

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

/** The models `fallbacks: "default"` may answer with instead of the one asked, which each need a price. */
export const FALLBACK_MODELS: Record<string, string[]> = {
  "claude-opus-5-5": ["claude-opus-5", "claude-opus-4-8"],
  "claude-sonnet-5-5": ["claude-sonnet-5"],
};

/**
 * A model with no price here: Claude Fable's rates, the highest of any model, so the API's charge is
 * still recorded and never under-counted.
 */
const UNKNOWN_PRICE: (typeof PRICES)[string] = { input: 10, output: 50, cacheRead: 1 };
const unpriced = new Set<string>();

export function priceOf(model: string) {
  const p = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
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

/**
 * Rough prompt tokens in a conversation, for the estimate before a request: text by length, images at
 * their typical size, PDFs by their size. Base64 bytes don't count as text.
 */
export function estimateTokens(messages: unknown): number {
  let chars = 0;
  let images = 0;
  let pdfTokens = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image") {
        images++;
        return;
      }
      const source = o.source as { type?: string; data?: unknown } | undefined;
      if (o.type === "document" && source?.type === "base64") {
        // A page or two per 100 KB; about 1,500 tokens a page.
        const kb = (String(source.data ?? "").length * 0.75) / 1024;
        pdfTokens += Math.max(1500, kb * 25);
        return;
      }
      for (const [k, x] of Object.entries(o)) {
        if (typeof x !== "string") walk(x);
        else if (!(k === "data" && o.type === "base64") && k !== "signature") chars += x.length;
      }
    }
  };
  walk(messages);
  return chars / 3.5 + images * 1600 + pdfTokens;
}

/** Rough tokens in a request's system prompt and tools, which estimateTokens leaves out. */
export const fixedTokens = (system: unknown, tools: unknown) =>
  JSON.stringify([system, tools]).length / 3;

/** The most web searches a request with these tools may make: each search tool's max_uses. */
export const searchesIn = (tools: readonly unknown[]) =>
  tools.reduce<number>((n, t) => {
    const tool = t as { name?: string; max_uses?: number };
    return n + (tool.name === "web_search" ? (tool.max_uses ?? 0) : 0);
  }, 0);

/**
 * The most one request may cost, for the check before it's made (PLAN.md §6.3): the prompt not known
 * to be in the cache priced as a cache write (`write`, the TTL its breakpoints use) or plain input, the
 * part that is at the read price, all of max_tokens as output, and every web search it may make.
 * With `fallbacks`, a model that declines partway is billed for what it read, and one of
 * FALLBACK_MODELS answers at its own rates, with none of the prompt in its cache.
 */
export function requestCeiling(
  model: string,
  r: {
    /** Prompt tokens, estimated. */
    prompt: number;
    /** Of those, ones the last request left in the cache, still within its TTL. */
    cached?: number;
    write?: "5m" | "1h";
    maxTokens: number;
    webSearches?: number;
    /** Sent with `fallbacks: "default"`. */
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
  const others = r.fallbacks ? (FALLBACK_MODELS[model] ?? []) : [];
  if (!others.length) return own + searches;
  const declined = ceiling(model, r.cached ?? 0, 0);
  const rescue = Math.max(...others.map((m) => ceiling(m, 0, r.maxTokens)));
  return Math.max(own, declined + rescue) + searches;
}

/** Work that may spend the reserve kept at the end of the limits: alerts, and the heartbeat. */
export const usesReserve = (origin: string) => origin === "alert" || origin === "heartbeat";

export class BudgetError extends Error {
  constructor(
    readonly limit: "task" | "daily" | "monthly",
    message: string,
  ) {
    super(message);
  }
}

/** Every kind of token a request used. */
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
  /** Requests in flight: the most each may cost, and its task's tree (the task that started it). */
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
    /** Charges on top of tokens, like web searches. */
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

  /** The last `hours` hours, oldest first, including hours with nothing spent. */
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

  private sumSince(since: Date, where = "", ...args: (string | number)[]): number {
    const row = this.db
      .query<{ total: number | null }, (string | number)[]>(
        `SELECT sum(cost_usd) AS total FROM spend_ledger WHERE created_at >= ? ${where}`,
      )
      .get(since.toISOString(), ...args);
    return row?.total ?? 0;
  }

  /** Today's and this month's spend: summed once a day, then only the rows added since. */
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

  taskSpend(taskId: number): number {
    return this.sumSince(new Date(0), "AND task_id = ?", taskId);
  }

  /** What a task's tree, which shares its limit, has spent: the task that started it and all under it. */
  treeSpend(taskId: number): number {
    return this.tree(taskId).usd;
  }

  /**
   * A task's tree: the task that started it (or it), and every task started under that one, which
   * share its limit; and what they have spent together.
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
         SELECT (SELECT id FROM up WHERE parent IS NULL) AS root,
           (SELECT sum(cost_usd) FROM spend_ledger WHERE task_id IN tree) AS usd`,
      )
      .get(taskId);
    // A task the ledger knows but the tasks table doesn't: on its own.
    return row?.root == null
      ? { root: taskId, usd: this.taskSpend(taskId) }
      : { root: row.root, usd: row.usd ?? 0 };
  }

  /**
   * Throws BudgetError if a request estimated at `estimateUsd` would cross a limit, counting what the
   * requests in flight may still cost. A task's limit (`limitUsd`, its tree's) covers the tasks it
   * started and the task that started it. Only work with `reserve` may spend the last
   * `alertReserveUsd` of the daily and monthly limits. Returns the task's tree's root, for hold().
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
   * check(), then holds `estimateUsd` against the limits while the request is in flight, so requests
   * made at once can't pass a limit together. Call what it returns once the request has ended and its
   * cost is recorded.
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

  byModel(days: number): { model: string; usd: number }[] {
    const from = startOfLocalDay(this.clock() - (days - 1) * 86400_000);
    return this.db
      .query<{ model: string; usd: number }, [string]>(
        "SELECT model, sum(cost_usd) AS usd FROM spend_ledger WHERE created_at >= ? GROUP BY model ORDER BY usd DESC",
      )
      .all(from.toISOString());
  }

  /** Spend per purpose (chat, task, heartbeat, tidy…), the most first, for Spend's breakdown. */
  byPurpose(days: number): SpendByPurpose[] {
    const from = startOfLocalDay(this.clock() - (days - 1) * 86400_000);
    return this.db
      .query<SpendByPurpose, [string]>(
        `SELECT purpose, sum(cost_usd) AS costUsd FROM spend_ledger
         WHERE created_at >= ? GROUP BY purpose ORDER BY costUsd DESC`,
      )
      .all(from.toISOString());
  }

  /** Spend per bot, for Spend's breakdown. */
  byBot(days: number): { botId: string; usd: number }[] {
    const from = startOfLocalDay(this.clock() - (days - 1) * 86400_000);
    return this.db
      .query<{ botId: string; usd: number }, [string]>(
        `SELECT coalesce(bot_id, 'hatbot') AS botId, sum(cost_usd) AS usd FROM spend_ledger
         WHERE created_at >= ? GROUP BY coalesce(bot_id, 'hatbot') ORDER BY usd DESC`,
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
