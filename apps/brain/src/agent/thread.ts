// The single chat thread, run as episodes (PLAN.md §5.2, §5.3).
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { describeCron, type Schedule, type ThreadMessage } from "@hatbot/shared";
import type { Db } from "../db";
import type { EventBus } from "../events";
import type { MemoryStore } from "../memory/store";
import type { Plugins } from "../plugins/registry";
import type { Schedules } from "../schedules";
import type { SettingsStore } from "../settings";
import { BudgetError, priceOf, type Spend } from "../spend";
import type { Tasks } from "../tasks/service";
import type { Triggers } from "../triggers";
import { type ModelClient, modelErrorText } from "./model";
import { SUMMARY_PROMPT, SYSTEM_PROMPT } from "./prompt";
import { runTool, TOOL_PARAMS, toolParam } from "./tools";

export const CHAT_MODEL = "claude-opus-5-5";
export const SUMMARY_MODEL = "claude-haiku-5-5";
const EPISODE_IDLE_MS = 30 * 60_000;
const RECENT_MESSAGES = 10;
const MAX_STEPS = 25;
const MAX_TURN_MS = 10 * 60_000;
const MESSAGE_COLUMNS =
  "id, role, kind, text, status, created_at AS createdAt, task_id AS taskId, approval_id AS approvalId, schedule_id AS scheduleId";
const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  "server-side-fallback-2026-07-01",
  "thinking-display-updates-2026-08-18",
  "thinking-binding-controls-2026-08-01",
];
/**
 * What an episode's thinking blocks are bound to: the system prompt, the tools and the model. The API
 * rejects replayed thinking when these change, so an update or a plugin switched on or off that changes
 * them starts a new episode.
 */
const prefixOf = (system: string, tools: Anthropic.Beta.BetaTool[]) =>
  createHash("sha256")
    .update(JSON.stringify([CHAT_MODEL, system, tools]))
    .digest("hex")
    .slice(0, 16);

type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type Turn = Anthropic.Beta.BetaMessageParam;

export type ThreadDeps = {
  /** Set once these exist; they need the thread too. */
  tasks?: Tasks;
  schedules?: Schedules;
  triggers?: Triggers;
  db: Db;
  memory: MemoryStore;
  events: EventBus;
  spend: Spend;
  settings: SettingsStore;
  model: ModelClient;
  plugins: Plugins;
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
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(before ?? Number.MAX_SAFE_INTEGER, limit)
      .reverse();
  }

  /** A task, approval or schedule card in the thread. `text` is what search and summaries see. */
  addCard(
    kind: "task" | "approval" | "schedule",
    text: string,
    ref: { taskId?: number; approvalId?: number; scheduleId?: number },
  ) {
    const row = this.d.db
      .query<ThreadMessage, [string, string, string, number | null, number | null, number | null]>(
        `INSERT INTO messages (role, kind, text, status, created_at, task_id, approval_id, schedule_id)
         VALUES ('assistant', ?, ?, 'done', ?, ?, ?, ?) RETURNING ${MESSAGE_COLUMNS}`,
      )
      .get(
        kind,
        text,
        this.now(),
        ref.taskId ?? null,
        ref.approvalId ?? null,
        ref.scheduleId ?? null,
      );
    if (!row) throw new Error("card insert failed");
    this.d.events.emit({ type: "message.created", message: row });
    return row;
  }

  /** Shows a task under the reply that started it, so its progress and result don't need a card. */
  attachTask(messageId: number, taskId: number): boolean {
    const done = this.d.db
      .query("UPDATE messages SET task_id = ? WHERE id = ? AND task_id IS NULL AND kind = 'text'")
      .run(taskId, messageId).changes;
    if (done) this.d.events.emit({ type: "message.task", id: messageId, taskId });
    return done > 0;
  }

  /** Stores the owner's message and queues Hatbot's reply, which streams over the event bus. */
  post(text: string): { message: ThreadMessage; done: Promise<void> } {
    const message = this.insertMessage("user", text, "done");
    const done = this.chain.then(() => this.reply(message));
    this.chain = done.catch((err) => console.error("thread turn failed", err));
    return { message, done };
  }

  attach(parts: Pick<ThreadDeps, "tasks" | "schedules" | "triggers">) {
    Object.assign(this.d, parts);
  }

  /** The episode has read untrusted content: tasks and schedules it makes from here on start tainted. */
  private taint(episodeId: number) {
    this.d.db.query("UPDATE episodes SET tainted = 1 WHERE id = ?").run(episodeId);
  }

  /**
   * A new episode carries recent messages over. It starts tainted if any of them came from a tainted
   * episode or a tainted task (PLAN.md §6.1).
   */
  private inheritTaint(episodeId: number, beforeMessageId: number) {
    const recent = this.list(beforeMessageId, RECENT_MESSAGES).map((m) => m.id);
    if (!recent.length) return;
    const tainted = this.d.db
      .query<{ n: number }, number[]>(
        `SELECT count(*) AS n FROM messages m
         LEFT JOIN episodes e ON e.id = m.episode_id
         LEFT JOIN tasks t ON t.id = m.task_id
         WHERE m.id IN (${recent.map(() => "?").join(", ")}) AND (e.tainted = 1 OR t.tainted = 1)`,
      )
      .get(...recent)?.n;
    if (tainted) this.taint(episodeId);
  }

  private tainted(episodeId: number): boolean {
    return Boolean(
      this.d.db
        .query<{ tainted: number }, [number]>("SELECT tainted FROM episodes WHERE id = ?")
        .get(episodeId)?.tainted,
    );
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
         RETURNING ${MESSAGE_COLUMNS}`,
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

  /**
   * Continues the current episode, or starts a new one after 30 minutes idle, or when an update changed
   * the system prompt, tools or model.
   */
  private async episodeFor(prefix: string): Promise<{ id: number; isNew: boolean }> {
    const last = this.d.db
      .query<
        { id: number; last_activity_at: string; summarized: number; prefix: string | null },
        []
      >("SELECT id, last_activity_at, summarized, prefix FROM episodes ORDER BY id DESC LIMIT 1")
      .get();
    if (last && this.clock() - Date.parse(last.last_activity_at) < EPISODE_IDLE_MS) {
      if (last.prefix === prefix) return { id: last.id, isNew: false };
      console.log(`episode ${last.id}: the prompt or tools changed; starting a new episode`);
    }
    if (last && !last.summarized) {
      try {
        await this.summarize(last.id);
      } catch (err) {
        console.error("thread summary failed; keeping the previous one", err);
      }
    }
    const row = this.d.db
      .query<{ id: number }, [string, string, string]>(
        "INSERT INTO episodes (started_at, last_activity_at, prefix) VALUES (?, ?, ?) RETURNING id",
      )
      .get(this.now(), this.now(), prefix);
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
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
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
    const { db, events, spend, settings, model, plugins } = this.d;
    // Fixed for the turn; a plugin switched on or off shows from the next one.
    const guidance = plugins.guidance();
    const system = guidance ? `${SYSTEM_PROMPT}\n\nYour plugins\n\n${guidance}` : SYSTEM_PROMPT;
    const pluginTools = plugins.tools("chat");
    const tools = [...TOOL_PARAMS, ...pluginTools.map(toolParam)];
    const episode = await this.episodeFor(prefixOf(system, tools));
    db.query("UPDATE messages SET episode_id = ? WHERE id = ?").run(episode.id, user.id);

    const userBlocks: BlockParam[] = [];
    if (episode.isNew) {
      userBlocks.push({ type: "text", text: await this.episodeContext(user.id) });
      this.inheritTaint(episode.id, user.id);
    }
    // An untrusted MCP server's tool descriptions are in the prompt now.
    if (pluginTools.some((t) => t.untrustedDefinition)) this.taint(episode.id);
    const ended = this.d.tasks?.takeUnreported() ?? [];
    // What tainted tasks report carries what they read.
    if (ended.some((t) => t.tainted)) this.taint(episode.id);
    if (ended.length) {
      const lines = ended.map((t) => `Task #${t.id} "${t.title}" ${t.status}: ${t.summary ?? ""}`);
      userBlocks.push({
        type: "text",
        text: `<task_updates>\n${lines.join("\n")}\n</task_updates>`,
      });
    }
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
                text: system,
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
            cache_control: { type: "ephemeral", ttl: "1h" },
            tools,
            // If a replayed thinking block fails the conversation check anyway, lose that reasoning
            // rather than the reply.
            thinking: {
              type: "adaptive",
              display: "updates",
              block_binding: { prefix_mismatch_behavior: "drop_block" },
            },
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
        if (res.input_transformations?.length)
          console.warn(
            `episode ${episode.id}: the API changed the input`,
            JSON.stringify(res.input_transformations).slice(0, 1000),
          );
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
            text: `\n${pluginTools.find((t) => t.name === call.name)?.label ?? toolLabel(call.name, plugins)}\n`,
          });
          const r = await runTool(
            call.name,
            call.input,
            {
              ...this.d,
              messageId: out.id,
              tainted: () => this.tainted(episode.id),
              taint: () => this.taint(episode.id),
              scheduleCard: (sc: Schedule) =>
                this.addCard(
                  "schedule",
                  `Schedule "${sc.name}": ${sc.cron ? describeCron(sc.cron) : `once at ${sc.runAt}`}. ${sc.prompt}`,
                  { scheduleId: sc.id },
                ),
            },
            abort.signal,
          );
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
      return finish(
        "error",
        `_Something went wrong talking to the model (${modelErrorText(err)})._`,
      );
    } finally {
      this.current = null;
    }
  }
}

function toolLabel(name: string, plugins: Plugins): string {
  const labels: Record<string, string> = {
    memory_list: "Looking through memory",
    memory_read: "Reading memory",
    memory_write: "Saving to memory",
    memory_delete: "Removing from memory",
    memory_search: "Searching memory",
    search_history: "Searching earlier messages",
    run_desktop_task: "Starting a desktop task",
    get_task: "Checking on a task",
    schedule_create: "Creating a schedule",
    schedule_list: "Looking at schedules",
    schedule_update: "Changing a schedule",
    schedule_delete: "Deleting a schedule",
    trigger_list: "Looking at triggers",
    trigger_update: "Changing a trigger",
    run_task: "Starting a task",
  };
  const plugin = plugins.pluginOf(name);
  return labels[name] ?? `Using ${plugin?.name ?? name}`;
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
