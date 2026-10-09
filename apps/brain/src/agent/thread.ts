// The single chat thread, run as episodes (PLAN.md §5.2, §5.3).
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db";
import type { EventBus } from "../events";
import type { MemoryStore } from "../memory/store";
import type { SettingsStore } from "../settings";
import { BudgetError, priceOf, type Spend } from "../spend";
import type { ModelClient } from "./model";
import { SUMMARY_PROMPT, SYSTEM_PROMPT } from "./prompt";
import { runTool, TOOL_PARAMS } from "./tools";

export const CHAT_MODEL = "claude-sonnet-5-5";
export const SUMMARY_MODEL = "claude-haiku-4-5";
const EPISODE_IDLE_MS = 30 * 60_000;
const RECENT_MESSAGES = 10;
const MAX_STEPS = 25;
const MAX_TURN_MS = 10 * 60_000;
const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  "server-side-fallback-2026-07-01",
  "thinking-display-updates-2026-08-18",
];

type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type Turn = Anthropic.Beta.BetaMessageParam;
export type ThreadMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  status: string;
  createdAt: string;
};

export type ThreadDeps = {
  db: Db;
  memory: MemoryStore;
  events: EventBus;
  spend: Spend;
  settings: SettingsStore;
  model: ModelClient;
  clock?: () => number;
};

export class Thread {
  private chain: Promise<void> = Promise.resolve();
  private current: AbortController | null = null;
  private clock: () => number;

  constructor(private d: ThreadDeps) {
    this.clock = d.clock ?? Date.now;
    // A restart cuts off any reply that was streaming.
    d.db.query("UPDATE messages SET status = 'error' WHERE status = 'streaming'").run();
  }

  list(before?: number, limit = 50): ThreadMessage[] {
    return this.d.db
      .query<ThreadMessage, [number, number]>(
        `SELECT id, role, text, status, created_at AS createdAt FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(before ?? Number.MAX_SAFE_INTEGER, limit)
      .reverse();
  }

  /** Stores the owner's message and queues Hatbot's reply, which streams over the event bus. */
  post(text: string): { message: ThreadMessage; done: Promise<void> } {
    const message = this.insertMessage("user", text, "done");
    const done = this.chain.then(() => this.reply(message));
    this.chain = done.catch((err) => console.error("thread turn failed", err));
    return { message, done };
  }

  /** Pause all: stops the reply in progress. */
  abortCurrent() {
    this.current?.abort();
  }

  /** Waits for queued replies (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  private insertMessage(
    role: "user" | "assistant",
    text: string,
    status: string,
    episodeId?: number,
  ): ThreadMessage {
    const row = this.d.db
      .query<ThreadMessage, [number | null, string, string, string, string]>(
        `INSERT INTO messages (episode_id, role, text, status, created_at) VALUES (?, ?, ?, ?, ?)
         RETURNING id, role, text, status, created_at AS createdAt`,
      )
      .get(episodeId ?? null, role, text, status, this.now());
    if (!row) throw new Error("message insert failed");
    this.d.events.emit({ type: "message.created", message: row });
    return row;
  }

  private appendTurn(
    episodeId: number,
    role: "user" | "assistant",
    content: BlockParam[] | Anthropic.Beta.BetaContentBlock[],
  ) {
    this.d.db
      .query(
        "INSERT INTO episode_turns (episode_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(episodeId, role, JSON.stringify(content), this.now());
  }

  private loadTurns(episodeId: number): Turn[] {
    return this.d.db
      .query<{ role: "user" | "assistant"; content: string }, [number]>(
        "SELECT role, content FROM episode_turns WHERE episode_id = ? ORDER BY id",
      )
      .all(episodeId)
      .map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
  }

  /** Continues the current episode, or starts a new one after 30 minutes idle. */
  private async episodeFor(): Promise<{ id: number; isNew: boolean }> {
    const last = this.d.db
      .query<{ id: number; last_activity_at: string; summarized: number }, []>(
        "SELECT id, last_activity_at, summarized FROM episodes ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (last && this.clock() - Date.parse(last.last_activity_at) < EPISODE_IDLE_MS) {
      return { id: last.id, isNew: false };
    }
    if (last && !last.summarized) {
      try {
        await this.summarize(last.id);
      } catch (err) {
        console.error("thread summary failed; keeping the previous one", err);
      }
    }
    const row = this.d.db
      .query<{ id: number }, [string, string]>(
        "INSERT INTO episodes (started_at, last_activity_at) VALUES (?, ?) RETURNING id",
      )
      .get(this.now(), this.now());
    if (!row) throw new Error("episode insert failed");
    return { id: row.id, isNew: true };
  }

  private threadSummary(): string {
    return (
      this.d.db
        .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'thread_summary'")
        .get()?.value ?? ""
    );
  }

  /** Folds a finished episode into the rolling thread summary with Haiku. */
  async summarize(episodeId: number) {
    const transcript = this.d.db
      .query<{ role: string; text: string; created_at: string }, [number]>(
        "SELECT role, text, created_at FROM messages WHERE episode_id = ? AND status != 'streaming' ORDER BY id",
      )
      .all(episodeId)
      .map(
        (m) =>
          `[${localStamp(new Date(m.created_at))}] ${m.role === "user" ? "Owner" : "Hatbot"}: ${m.text}`,
      )
      .join("\n\n");
    if (transcript) {
      const res = await this.d.model.create({
        model: SUMMARY_MODEL,
        max_tokens: 2000,
        system: SUMMARY_PROMPT,
        messages: [
          {
            role: "user",
            content: `<previous_summary>\n${this.threadSummary() || "(none)"}\n</previous_summary>\n\n<conversation>\n${transcript}\n</conversation>`,
          },
        ],
      });
      this.d.spend.recordResponse({
        model: SUMMARY_MODEL,
        purpose: "summary",
        usage: res.usage,
        episodeId,
      });
      const summary = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (res.stop_reason === "end_turn" && summary) {
        this.d.db
          .query(
            "INSERT INTO settings (key, value) VALUES ('thread_summary', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          )
          .run(summary);
      }
    }
    this.d.db.query("UPDATE episodes SET summarized = 1 WHERE id = ?").run(episodeId);
  }

  /** Opening context for a new episode: memory index, summary, the last few messages. */
  private async episodeContext(beforeMessageId: number): Promise<string> {
    const index = (await this.d.memory.exists("INDEX.md"))
      ? await this.d.memory.read("INDEX.md")
      : "(no INDEX.md yet)";
    const recent = this.list(beforeMessageId, RECENT_MESSAGES)
      .filter((m) => m.status !== "streaming")
      .map(
        (m) =>
          `[${localStamp(new Date(m.createdAt))}] ${m.role === "user" ? "Owner" : "Hatbot"}: ${m.text}`,
      )
      .join("\n\n");
    return [
      "<context>",
      `<memory_index>\n${index.trim()}\n</memory_index>`,
      `<summary_of_earlier_conversations>\n${this.threadSummary() || "(none yet)"}\n</summary_of_earlier_conversations>`,
      `<recent_messages>\n${recent || "(none)"}\n</recent_messages>`,
      "</context>",
    ].join("\n");
  }

  private async reply(user: ThreadMessage) {
    const { db, events, spend, settings, model } = this.d;
    const episode = await this.episodeFor();
    db.query("UPDATE messages SET episode_id = ? WHERE id = ?").run(episode.id, user.id);

    const userBlocks: BlockParam[] = [];
    if (episode.isNew) userBlocks.push({ type: "text", text: await this.episodeContext(user.id) });
    userBlocks.push({
      type: "text",
      text: `[${localStamp(new Date(user.createdAt))}]\n${user.text}`,
    });
    this.appendTurn(episode.id, "user", userBlocks);

    const out = this.insertMessage("assistant", "", "streaming", episode.id);
    let text = "";
    let separate = false;
    const say = (delta: string) => {
      if (separate && text) {
        delta = `\n\n${delta}`;
      }
      separate = false;
      text += delta;
      events.emit({ type: "message.delta", id: out.id, text: delta });
    };
    const finish = (status: "done" | "error", note?: string) => {
      if (note) {
        separate = true;
        say(note);
      }
      db.query("UPDATE messages SET text = ?, status = ? WHERE id = ?").run(text, status, out.id);
      db.query("UPDATE episodes SET last_activity_at = ? WHERE id = ?").run(this.now(), episode.id);
      events.emit({ type: "message.done", id: out.id, text, status });
    };

    const started = this.clock();
    const abort = new AbortController();
    this.current = abort;
    try {
      for (let step = 0; ; step++) {
        const s = settings.get();
        if (s.paused) return finish("error", "_Paused. Resume to continue._");
        if (step >= MAX_STEPS || this.clock() - started > MAX_TURN_MS) {
          return finish("error", "_Stopped: this reply hit its step or time limit._");
        }

        const messages = this.loadTurns(episode.id);
        try {
          spend.check(estimateCost(messages));
        } catch (err) {
          if (err instanceof BudgetError) return finish("error", `_Stopped: ${err.message}_`);
          throw err;
        }

        const res = await model.stream(
          {
            model: CHAT_MODEL,
            max_tokens: 32000,
            betas: BETAS,
            fallbacks: "default",
            // Tools and system are stable; the 1-hour cache keeps a 30-minute episode cheap.
            system: [
              {
                type: "text",
                text: SYSTEM_PROMPT,
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
            cache_control: { type: "ephemeral", ttl: "1h" },
            tools: TOOL_PARAMS,
            thinking: { type: "adaptive", display: "updates" },
            output_config: { effort: s.chatEffort },
            messages,
          },
          {
            onText: say,
            onThinking: (delta) =>
              events.emit({ type: "message.progress", id: out.id, text: delta }),
            signal: abort.signal,
          },
        );
        separate = true;
        spend.recordResponse({
          model: CHAT_MODEL,
          purpose: "thread",
          usage: res.usage,
          episodeId: episode.id,
        });
        this.appendTurn(episode.id, "assistant", res.content);

        const toolUses = res.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
        );
        if (res.stop_reason === "pause_turn") continue;
        if (res.stop_reason === "refusal") {
          return finish(
            "done",
            text ? "_(I stopped there: I can't help with the rest.)_" : "I can't help with that.",
          );
        }
        if (!toolUses.length) {
          if (res.stop_reason === "max_tokens") return finish("error", "_(My reply was cut off.)_");
          return finish("done");
        }

        // Every tool_use needs a result, or the episode can't continue.
        const results: BlockParam[] = [];
        for (const call of toolUses) {
          if (res.stop_reason === "max_tokens") {
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content: "Input was cut off at max_tokens. Retry with a shorter input.",
            });
            continue;
          }
          events.emit({
            type: "message.progress",
            id: out.id,
            text: `\n${toolLabel(call.name)}\n`,
          });
          const r = await runTool(call.name, call.input, this.d);
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: r.isError,
            content: r.content,
          });
        }
        this.appendTurn(episode.id, "user", results);
      }
    } catch (err) {
      if (abort.signal.aborted) return finish("error", "_Paused. Resume to continue._");
      console.error("chat turn failed", err);
      return finish("error", "_Something went wrong talking to the model. Try again in a moment._");
    } finally {
      this.current = null;
    }
  }
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    memory_list: "Looking through memory",
    memory_read: "Reading memory",
    memory_write: "Saving to memory",
    memory_delete: "Removing from memory",
    memory_search: "Searching memory",
    search_history: "Searching earlier messages",
  };
  return labels[name] ?? `Using ${name}`;
}

/** Rough upper estimate before a request: cached prefix at read price, plus room for a reply. */
function estimateCost(messages: Turn[]): number {
  const p = priceOf(CHAT_MODEL);
  const tokens = JSON.stringify(messages).length / 3 + 4000;
  return (tokens * p.input * 0.25 + 2000 * p.output) / 1_000_000;
}

/** "Thu 2026-10-09 18:04", in the brain's local time. */
export function localStamp(d: Date): string {
  const day = d.toLocaleDateString("en-GB", { weekday: "short" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
