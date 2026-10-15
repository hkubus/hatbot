// Spend ledger and limits (PLAN.md §6.3).
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

export function priceOf(model: string) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for model ${model}`);
  return p;
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
    const s = this.summary();
    this.events.emit({ type: "spend.updated", todayUsd: s.todayUsd, monthUsd: s.monthUsd });
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

  summary() {
    const now = this.clock();
    const today = this.windowSince(startOfLocalDay(now));
    return {
      todayUsd: today.usd,
      monthUsd: this.sumSince(startOfLocalMonth(now)),
      limits: this.settings.get().limits,
      todayTokens: today.tokens,
      lastHour: this.windowSince(new Date(now - 3600_000)),
      lastMinute: this.windowSince(new Date(now - 60_000)),
    };
  }

  taskSpend(taskId: number): number {
    return this.sumSince(new Date(0), "AND task_id = ?", taskId);
  }

  /** Throws BudgetError if a request estimated at `estimateUsd` would cross a limit. */
  check(estimateUsd: number, task?: { id: number; limitUsd: number }) {
    const { todayUsd, monthUsd, limits } = this.summary();
    if (task && this.taskSpend(task.id) + estimateUsd > task.limitUsd) {
      throw new BudgetError("task", `This task would go over its $${task.limitUsd} limit.`);
    }
    if (todayUsd + estimateUsd > limits.dailyUsd) {
      throw new BudgetError("daily", `Today's $${limits.dailyUsd} limit would be exceeded.`);
    }
    if (monthUsd + estimateUsd > limits.monthlyUsd) {
      throw new BudgetError(
        "monthly",
        `This month's $${limits.monthlyUsd} limit would be exceeded.`,
      );
    }
  }

  byModel(days: number): { model: string; usd: number }[] {
    const from = startOfLocalDay(this.clock() - (days - 1) * 86400_000);
    return this.db
      .query<{ model: string; usd: number }, [string]>(
        "SELECT model, sum(cost_usd) AS usd FROM spend_ledger WHERE created_at >= ? GROUP BY model ORDER BY usd DESC",
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
