// The single chat thread, run as episodes (PLAN.md §5.2, §5.3).
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { describeCron, type Episode, type Schedule, type ThreadMessage } from "@hatbot/shared";
import { z } from "zod";
import { type Approvals, ownerNote } from "../approvals";
import type { Attachments } from "../attachments";
import type { Db } from "../db";
import type { DesktopAgent } from "../desktop/client";
import type { EventBus } from "../events";
import type { MemoryStore } from "../memory/store";
import type { PluginTool } from "../plugins/plugin";
import {
  describeCall,
  type Plugins,
  runPluginTool,
  untrustedDefinitions,
  verdictFor,
} from "../plugins/registry";
import type { Schedules } from "../schedules";
import type { SettingsStore } from "../settings";
import { BudgetError, priceOf, type Spend, tokenCount, tokensOf } from "../spend";
import type { Tasks } from "../tasks/service";
import type { Triggers } from "../triggers";
import { type ModelClient, modelErrorText } from "./model";
import { EXPERT_PROMPT, SUMMARY_PROMPT, SYSTEM_PROMPT } from "./prompt";
import { mayReview, safeToRun } from "./review";
import {
  inBatches,
  LOOKUP_TOOLS,
  runTool,
  TOOL_PARAMS,
  toolParam,
  WEB_TOOLS,
  webReads,
} from "./tools";

/** What ask_opus consults when the chat runs on Haiku 5.5. */
export const EXPERT_MODEL = "claude-opus-5-5";
export const SUMMARY_MODEL = "claude-haiku-5-5";
const EPISODE_IDLE_MS = 30 * 60_000;
const RECENT_MESSAGES = 10;
const MAX_STEPS = 25;
const MAX_TURN_MS = 10 * 60_000;
/** Changes one reply makes itself; past this, the work belongs in a background task (run_task). */
const MAX_CHAT_CHANGES = 2;
const MESSAGE_COLUMNS =
  "id, role, kind, text, status, created_at AS createdAt, task_id AS taskId, schedule_id AS scheduleId, episode_id AS episodeId, edited_at AS editedAt, seen_at AS seenAt";
const EPISODE_COLUMNS = "id, started_at AS startedAt, last_activity_at AS lastActivityAt, recap";
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
const prefixOf = (model: string, system: string, tools: Anthropic.Beta.BetaToolUnion[]) =>
  createHash("sha256")
    .update(JSON.stringify([model, system, tools]))
    .digest("hex")
    .slice(0, 16);

const AskOpus = z.object({
  question: z
    .string()
    .min(1)
    .max(4000)
    .describe("What to answer or write, exactly as the owner needs it"),
  context: z
    .string()
    .max(60_000)
    .describe(
      "Everything Opus needs: the relevant messages, code, errors, file contents, versions. It can't see this conversation",
    ),
});

/** Offered only when the chat runs on Haiku 5.5. */
const ASK_OPUS = toolParam({
  name: "ask_opus",
  description:
    "Hand one hard part of this reply to Claude Opus 5.5, a stronger and costlier model. Use it only for: writing or reviewing more than a few lines of code, debugging, a problem that needs several careful steps of reasoning, or when the owner asks for Opus. Not for looking things up, memory, schedules, chat, summaries, short answers or anything you can answer well yourself. At most once per reply. Opus can't see the conversation or use tools, so give it the question and all the context it needs. Its answer is shown to the owner as is; you don't repeat it.",
  schema: AskOpus,
});

type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type Turn = Anthropic.Beta.BetaMessageParam;

export type ThreadDeps = {
  /** Set once these exist; they need the thread too. */
  tasks?: Tasks;
  schedules?: Schedules;
  triggers?: Triggers;
  approvals?: Approvals;
  /** Files in the chat, and the desktop whose sandbox send_file takes them from. */
  attachments?: Attachments;
  desktop?: DesktopAgent;
  db: Db;
  memory: MemoryStore;
  events: EventBus;
  spend: Spend;
  settings: SettingsStore;
  model: ModelClient;
  plugins: Plugins;
  clock?: () => number;
};

/** The two parts of Haiku's answer; an answer without the tags is all running summary. */
export function parseSummary(out: string): { recap: string | null; summary: string } {
  const tag = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(out)?.[1]?.trim();
  const summary = tag("summary");
  if (summary === undefined) return { recap: null, summary: out.trim() };
  return { recap: tag("recap")?.slice(0, 400) || null, summary };
}

export class Thread {
  private chain: Promise<void> = Promise.resolve();
  /** Summaries being written, so the sweep and a new message don't write one twice. */
  private summarizing = new Map<number, Promise<void>>();
  private current: AbortController | null = null;
  /** The approval the reply in progress waits for; your next message cancels it. */
  private waiting: number | null = null;
  private clock: () => number;

  constructor(private d: ThreadDeps) {
    this.clock = d.clock ?? Date.now;
    // A restart cuts off any reply that was streaming.
    d.db.query("UPDATE messages SET status = 'error' WHERE status = 'streaming'").run();
  }

  list(before?: number, limit = 50): ThreadMessage[] {
    const rows = this.d.db
      .query<ThreadMessage, [number, number]>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(before ?? Number.MAX_SAFE_INTEGER, limit)
      .reverse();
    return this.d.attachments?.fill(rows) ?? rows;
  }

  /** A task or schedule card in the thread. `text` is what search and summaries see. */
  addCard(kind: "task" | "schedule", text: string, ref: { taskId?: number; scheduleId?: number }) {
    const row = this.d.db
      .query<ThreadMessage, [string, string, string, number | null, number | null]>(
        `INSERT INTO messages (role, kind, text, status, created_at, task_id, schedule_id)
         VALUES ('assistant', ?, ?, 'done', ?, ?, ?) RETURNING ${MESSAGE_COLUMNS}`,
      )
      .get(kind, text, this.now(), ref.taskId ?? null, ref.scheduleId ?? null);
    if (!row) throw new Error("card insert failed");
    this.d.events.emit({ type: "message.created", message: row });
    return row;
  }

  /** Hatbot's messages sent or edited since you last saw them, oldest first. */
  unread(): number[] {
    return this.d.db
      .query<{ id: number }, []>(
        `SELECT id FROM messages WHERE role = 'assistant' AND status != 'streaming'
         AND (seen_at IS NULL OR seen_at < coalesce(edited_at, created_at)) ORDER BY id`,
      )
      .all()
      .map((r) => r.id);
  }

  /** You saw these messages. One still streaming isn't seen until it's done. */
  markSeen(ids: number[]) {
    const seenAt = this.now();
    const marked = this.d.db
      .query<{ id: number }, (string | number)[]>(
        `UPDATE messages SET seen_at = ? WHERE id IN (${ids.map(() => "?").join(", ")})
         AND status != 'streaming' RETURNING id`,
      )
      .all(seenAt, ...ids)
      .map((r) => r.id);
    if (marked.length) this.d.events.emit({ type: "message.seen", ids: marked, seenAt });
  }

  /** A task's result changed these messages: the card that showed it running, or the reply that started it. */
  markEdited(taskId: number) {
    const editedAt = this.now();
    const rows = this.d.db
      .query<{ id: number }, [string, number]>(
        "UPDATE messages SET edited_at = ? WHERE task_id = ? AND kind IN ('text', 'task') RETURNING id",
      )
      .all(editedAt, taskId);
    for (const r of rows) this.d.events.emit({ type: "message.edited", id: r.id, editedAt });
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
  post(
    text: string,
    attachmentIds: number[] = [],
  ): { message: ThreadMessage; done: Promise<void> } {
    const message = this.insertMessage("user", text, "done", undefined, attachmentIds);
    // Writing again instead of answering an approval moves on without it.
    if (this.waiting !== null) this.d.approvals?.cancel(this.waiting);
    const done = this.chain.then(() => this.reply(message));
    this.chain = done.catch((err) => console.error("thread turn failed", err));
    return { message, done };
  }

  attach(
    parts: Pick<
      ThreadDeps,
      "tasks" | "schedules" | "triggers" | "approvals" | "attachments" | "desktop"
    >,
  ) {
    Object.assign(this.d, parts);
  }

  /**
   * The episode has read untrusted content, `by`: tasks and schedules it makes from here on start
   * tainted. The first `by` is kept.
   */
  private taint(episodeId: number, by: string) {
    this.d.db
      .query("UPDATE episodes SET tainted = 1, tainted_by = coalesce(tainted_by, ?) WHERE id = ?")
      .run(by, episodeId);
  }

  /**
   * A new episode carries recent messages over. It starts tainted if any of them came from a tainted
   * episode or a tainted task (PLAN.md §6.1).
   */
  private inheritTaint(episodeId: number, beforeMessageId: number) {
    const recent = this.list(beforeMessageId, RECENT_MESSAGES).map((m) => m.id);
    if (!recent.length) return;
    const from = this.d.db
      .query<{ episode: string | null; task_id: number | null; title: string | null }, number[]>(
        `SELECT CASE WHEN e.tainted = 1 THEN coalesce(e.tainted_by, '') END AS episode,
           t.id AS task_id, t.title
         FROM messages m
         LEFT JOIN episodes e ON e.id = m.episode_id
         LEFT JOIN tasks t ON t.id = m.task_id
         WHERE m.id IN (${recent.map(() => "?").join(", ")}) AND (e.tainted = 1 OR t.tainted = 1)
         ORDER BY m.id LIMIT 1`,
      )
      .get(...recent);
    if (from)
      this.taint(
        episodeId,
        from.episode !== null
          ? from.episode || "Untrusted content"
          : `Task #${from.task_id} "${from.title}"`,
      );
  }

  /** Your last few messages in this conversation, as you wrote them. */
  private ownerSaid(episodeId: number): string {
    return this.d.db
      .query<{ text: string; created_at: string }, [number]>(
        "SELECT text, created_at FROM messages WHERE episode_id = ? AND role = 'user' ORDER BY id DESC LIMIT 3",
      )
      .all(episodeId)
      .reverse()
      .map((m) => `[${localStamp(new Date(m.created_at))}] ${m.text}`)
      .join("\n\n");
  }

  /** What the episode first read that was untrusted, or null. */
  private tainted(episodeId: number): string | null {
    const e = this.d.db
      .query<{ tainted: number; tainted_by: string | null }, [number]>(
        "SELECT tainted, tainted_by FROM episodes WHERE id = ?",
      )
      .get(episodeId);
    return e?.tainted ? (e.tainted_by ?? "Untrusted content") : null;
  }

  /**
   * A plugin tool that changes something, called from the chat: its policy and the untrusted-content
   * rule, then Haiku's review (it isn't destructive or dangerous), then your approval, which the reply
   * waits for (PLAN.md §6.1).
   */
  private async gatedCall(
    episodeId: number,
    t: PluginTool,
    input: unknown,
    signal: AbortSignal,
    progress: (line: string) => void,
  ): Promise<{ content: string; isError: boolean }> {
    const { approvals, settings } = this.d;
    const taintedBy = this.tainted(episodeId);
    const cc = { task: null, signal };
    const what = describeCall(t, input);
    const verdict = verdictFor(t, input, cc, taintedBy !== null);
    if (verdict.action === "block") return { content: `Refused: ${verdict.why}`, isError: true };
    let note: string | null = null;
    if (verdict.action === "ask") {
      const kind = verdict.kind ?? "other";
      let skip = false;
      let review = "";
      if (settings.get().reviewChanges && mayReview(verdict)) {
        progress("Checking it's safe");
        const check = await safeToRun(
          this.d,
          { episodeId },
          {
            ownerSaid: this.ownerSaid(episodeId),
            goal: "(none: the owner is asking in the chat)",
            sources: taintedBy ? [taintedBy] : [],
          },
          { tool: t.name, input, what, why: verdict.why },
        );
        skip = check.safe;
        review = check.why;
      }
      if (!skip) {
        if (!approvals)
          return { content: "Approvals aren't available; use run_task.", isError: true };
        const approval = approvals.create({
          taskId: null,
          kind,
          summary: what,
          reason: review ? `${verdict.why} Haiku: ${review}` : verdict.why,
          sources: taintedBy ? [taintedBy] : [],
        });
        progress("Waiting for your approval");
        this.waiting = approval.id;
        let outcome: Awaited<ReturnType<Approvals["wait"]>>;
        try {
          outcome = await approvals.wait(approval.id, signal);
        } finally {
          this.waiting = null;
          // A paused reply leaves nothing waiting.
          if (signal.aborted) approvals.cancel(approval.id);
        }
        note = approvals.get(approval.id)?.note ?? null;
        if (outcome !== "approved") {
          const content =
            outcome === "denied"
              ? note
                ? `The owner denied this. ${ownerNote(note)}`
                : "The owner denied this. Don't try it another way."
              : "The owner wrote again instead of answering, so this didn't run. Don't try it another way; end your reply briefly.";
          return { content, isError: true };
        }
      }
    }
    progress(activity(t.label ?? `Using ${t.name}`, input));
    const r = await runPluginTool(t, input, cc);
    if (r.untrusted) this.taint(episodeId, what);
    return { content: note ? `${r.content}\n\n${ownerNote(note)}` : r.content, isError: r.isError };
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
    attachmentIds: number[] = [],
  ): ThreadMessage {
    const inserted = this.d.db
      .query<ThreadMessage, [number | null, string, string, string, string]>(
        `INSERT INTO messages (episode_id, role, text, status, created_at) VALUES (?, ?, ?, ?, ?)
         RETURNING ${MESSAGE_COLUMNS}`,
      )
      .get(episodeId ?? null, role, text, status, this.now());
    if (!inserted) throw new Error("message insert failed");
    const files = this.d.attachments?.bind(attachmentIds, inserted.id) ?? [];
    const row = files.length ? { ...inserted, attachments: files } : inserted;
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

  episodes(ids: number[]): Episode[] {
    if (!ids.length) return [];
    return this.d.db
      .query<Episode, number[]>(
        `SELECT ${EPISODE_COLUMNS} FROM episodes WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`,
      )
      .all(...ids);
  }

  /**
   * Summarizes the last episode once it has been idle for 30 minutes, so it folds up in the chat
   * without waiting for the next message. The brain calls it every minute.
   */
  async sweep() {
    const last = this.d.db
      .query<{ id: number; last_activity_at: string }, []>(
        "SELECT id, last_activity_at FROM episodes WHERE summarized = 0 ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (!last || this.clock() - Date.parse(last.last_activity_at) < EPISODE_IDLE_MS) return;
    try {
      await this.summarize(last.id);
    } catch (err) {
      console.error("thread summary failed; trying again later", err);
    }
  }

  /** Folds a finished episode into the rolling thread summary with Haiku, and writes its recap. */
  summarize(episodeId: number): Promise<void> {
    const running = this.summarizing.get(episodeId);
    if (running) return running;
    const run = this.writeSummary(episodeId).finally(() => this.summarizing.delete(episodeId));
    this.summarizing.set(episodeId, run);
    return run;
  }

  private async writeSummary(episodeId: number) {
    const done = this.d.db
      .query<{ summarized: number }, [number]>("SELECT summarized FROM episodes WHERE id = ?")
      .get(episodeId)?.summarized;
    if (done) return;
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
      const out = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const { recap, summary } = parseSummary(out);
      if (res.stop_reason === "end_turn" && summary) {
        this.d.db
          .query(
            "INSERT INTO settings (key, value) VALUES ('thread_summary', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          )
          .run(summary);
        if (recap)
          this.d.db.query("UPDATE episodes SET recap = ? WHERE id = ?").run(recap, episodeId);
      }
    }
    this.d.db.query("UPDATE episodes SET summarized = 1 WHERE id = ?").run(episodeId);
    const [episode] = this.episodes([episodeId]);
    if (episode) this.d.events.emit({ type: "episode.updated", episode });
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
    const pluginTools = plugins.tools();
    // Fixed for the reply; a change starts a new episode, since thinking blocks are bound to the model.
    const chatModel = settings.get().chatModel;
    const onHaiku = chatModel === "claude-haiku-5-5";
    const tools = [
      ...TOOL_PARAMS,
      ...(onHaiku ? [ASK_OPUS] : []),
      ...pluginTools.map(toolParam),
      ...WEB_TOOLS,
    ];
    const episode = await this.episodeFor(prefixOf(chatModel, system, tools));
    db.query("UPDATE messages SET episode_id = ? WHERE id = ?").run(episode.id, user.id);
    // Clients file your message under its conversation now that it has one.
    events.emit({ type: "message.created", message: { ...user, episodeId: episode.id } });

    const userBlocks: BlockParam[] = [];
    if (episode.isNew) {
      userBlocks.push({ type: "text", text: await this.episodeContext(user.id) });
      this.inheritTaint(episode.id, user.id);
    }
    // An untrusted MCP server's tool descriptions are in the prompt now.
    const foreign = untrustedDefinitions(pluginTools);
    if (foreign) this.taint(episode.id, foreign);
    const ended = this.d.tasks?.takeUnreported() ?? [];
    // What tainted tasks report carries what they read.
    const tainted = ended.find((t) => t.tainted);
    if (tainted) this.taint(episode.id, `Task #${tainted.id} "${tainted.title}"`);
    if (ended.length) {
      const lines = ended.map((t) => `Task #${t.id} "${t.title}" ${t.status}: ${t.summary ?? ""}`);
      userBlocks.push({
        type: "text",
        text: `<task_updates>\n${lines.join("\n")}\n</task_updates>`,
      });
    }
    userBlocks.push({
      type: "text",
      text: `[${localStamp(new Date(user.createdAt))}]\n${user.text || "(no text, only files)"}`,
    });
    // Your files: what's in them was written by whoever made them, so they're untrusted (PLAN.md §6.1).
    if (user.attachments?.length && this.d.attachments) {
      userBlocks.push(...(await this.d.attachments.blocks(user.attachments)));
      this.taint(episode.id, `Attached file "${user.attachments[0]?.name}"`);
    }
    this.appendTurn(episode.id, "user", userBlocks);

    const out = this.insertMessage("assistant", "", "streaming", episode.id);
    let text = "";
    let separate = false;
    /** This reply's model calls so far, shown under the working dots. */
    const used = { tokens: 0, costUsd: 0 };
    const progress = (line: string) =>
      events.emit({ type: "message.progress", id: out.id, text: `\n${line}\n` });
    const say = (delta: string) => {
      // Text after a tool call gets a rule, so what came after the tool reads apart from what came before.
      if (separate && text) {
        delta = `\n\n---\n\n${delta}`;
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

    let askedOpus = false;
    /** ask_opus: one Opus 5.5 call, its answer streamed into this reply as is. */
    const askOpus = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<BlockParam> => {
      const result = (content: string, isError = false): BlockParam => ({
        type: "tool_result",
        tool_use_id: call.id,
        content,
        ...(isError ? { is_error: true } : {}),
      });
      const p = AskOpus.safeParse(call.input);
      if (!p.success) return result(`Invalid input: ${z.prettifyError(p.error)}`, true);
      if (askedOpus)
        return result("Opus was already asked once in this reply. Work with its answer.", true);
      askedOpus = true;
      const content = `<question>\n${p.data.question}\n</question>\n\n<context>\n${p.data.context || "(none)"}\n</context>`;
      const price = priceOf(EXPERT_MODEL);
      spend.check(((content.length / 3 + 2000) * price.input + 8000 * price.output) / 1_000_000);
      separate = true;
      const res = await model.stream(
        {
          model: EXPERT_MODEL,
          max_tokens: 32000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: EXPERT_PROMPT,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          messages: [{ role: "user", content }],
        },
        { onText: say, signal: abort.signal },
      );
      used.costUsd += spend.recordResponse({
        model: EXPERT_MODEL,
        purpose: "expert",
        usage: res.usage,
        episodeId: episode.id,
      });
      used.tokens += tokenCount(tokensOf(res.usage));
      events.emit({ type: "message.usage", id: out.id, ...used });
      separate = true;
      if (res.stop_reason === "refusal") return result("Opus declined to answer this.", true);
      return result(
        res.stop_reason === "max_tokens"
          ? "Opus's answer was cut off; it's in your reply as far as it got. Tell the owner, briefly."
          : "Opus's answer is now in your reply, shown to the owner as is. Don't repeat, summarise or rewrite it. Add at most a line if something needs saying; otherwise end your reply.",
      );
    };

    const started = this.clock();
    let waited = 0;
    let changes = 0;
    const abort = new AbortController();
    this.current = abort;
    try {
      for (let step = 0; ; step++) {
        const s = settings.get();
        if (s.paused) return finish("error", "_Paused. Resume to continue._");
        if (step >= MAX_STEPS || this.clock() - started - waited > MAX_TURN_MS) {
          return finish("error", "_Stopped: this reply hit its step or time limit._");
        }

        const messages = this.loadTurns(episode.id);
        try {
          spend.check(estimateCost(messages, chatModel));
        } catch (err) {
          if (err instanceof BudgetError) return finish("error", `_Stopped: ${err.message}_`);
          throw err;
        }

        progress("Thinking…");
        const res = await model.stream(
          {
            model: chatModel,
            max_tokens: 32000,
            betas: BETAS,
            // Haiku 5.5 has no server-side fallback; a refusal there ends the reply with a note.
            ...(onHaiku ? {} : { fallbacks: "default" as const }),
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
            // Haiku 5.5 writes no progress notes between tools, so it gets the default display.
            thinking: {
              type: "adaptive",
              ...(onHaiku ? {} : { display: "updates" as const }),
              block_binding: { prefix_mismatch_behavior: "drop_block" },
            },
            output_config: { effort: s.chatEffort },
            messages,
          },
          {
            onText: say,
            onThinking: (delta) =>
              events.emit({ type: "message.progress", id: out.id, text: delta }),
            onServerTool: (name, input) => {
              if (name === "web_search") progress(activity("Searching the web", input));
              else if (name === "web_fetch")
                progress(`Reading ${String(input.url ?? "a web page")}`);
            },
            signal: abort.signal,
          },
        );
        // A paused turn picks up mid-thought; only text after tools starts a new part.
        separate = res.stop_reason !== "pause_turn";
        if (res.input_transformations?.length)
          console.warn(
            `episode ${episode.id}: the API changed the input`,
            JSON.stringify(res.input_transformations).slice(0, 1000),
          );
        used.costUsd += spend.recordResponse({
          model: chatModel,
          purpose: "thread",
          usage: res.usage,
          episodeId: episode.id,
        });
        used.tokens += tokenCount(tokensOf(res.usage));
        events.emit({ type: "message.usage", id: out.id, ...used });
        this.appendTurn(episode.id, "assistant", res.content);
        // Web pages are untrusted (PLAN.md §6.1).
        const web = webReads(res.content);
        if (web.length) this.taint(episode.id, web[0] as string);

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

        // Every tool_use needs a result, or the episode can't continue. Lookups in a row run at once.
        const lookup = (call: Anthropic.Beta.BetaToolUseBlock) =>
          res.stop_reason !== "max_tokens" &&
          (LOOKUP_TOOLS.includes(call.name) ||
            pluginTools.find((t) => t.name === call.name)?.access === "read");
        const results = await inBatches(toolUses, lookup, async (call): Promise<BlockParam> => {
          if (res.stop_reason === "max_tokens")
            return {
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content: "Input was cut off at max_tokens. Retry with a shorter input.",
            };
          if (call.name === "ask_opus" && onHaiku) {
            progress("Asking Opus…");
            return askOpus(call);
          }
          const plugin = pluginTools.find((t) => t.name === call.name);
          // A change says what it's doing once its checks are done.
          if (plugin?.access !== "write")
            progress(activity(plugin?.label ?? toolLabel(call.name, plugins), call.input));
          const r = await runTool(
            call.name,
            call.input,
            {
              ...this.d,
              messageId: out.id,
              episodeId: episode.id,
              tainted: () => this.tainted(episode.id),
              taint: (by: string) => this.taint(episode.id, by),
              ownerSaid: () => this.ownerSaid(episode.id),
              gated: async (t, input, signal) => {
                // The sandbox is scratch space; only changes to the homelab and accounts count.
                if (plugins.pluginOf(t.name)?.id !== "code" && ++changes > MAX_CHAT_CHANGES)
                  return {
                    content: `Not run: that would be change number ${changes} in this reply, and the chat makes at most ${MAX_CHAT_CHANGES}. Start run_task for the rest, with everything you've found so far in its goal, and tell the owner it's running.`,
                    isError: true,
                  };
                const from = this.clock();
                try {
                  return await this.gatedCall(episode.id, t, input, signal, progress);
                } finally {
                  // Time waiting for you doesn't count against the reply's limit.
                  waited += this.clock() - from;
                }
              },
              scheduleCard: (sc: Schedule) =>
                this.addCard(
                  "schedule",
                  `Schedule "${sc.name}": ${sc.cron ? describeCron(sc.cron) : `once at ${sc.runAt}`}. ${sc.prompt}`,
                  { scheduleId: sc.id },
                ),
            },
            abort.signal,
          );
          return {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: r.isError,
            content: r.content,
          };
        });
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
    ask_opus: "Asking Opus",
    send_file: "Sending a file",
  };
  const plugin = plugins.pluginOf(name);
  return labels[name] ?? `Using ${plugin?.name ?? name}`;
}

/** Inputs worth naming in a working line, in this order. */
const SHOWN_INPUTS = [
  "path",
  "query",
  "title",
  "name",
  "host",
  "what",
  "unit",
  "repo",
  "id",
  "command",
];

/** "Reading memory: homelab.md", "Checking a host: nas, logs, nginx". */
export function activity(label: string, input: unknown): string {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const parts = SHOWN_INPUTS.map((k) => o[k])
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map((v) => String(v).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const detail = parts.join(", ");
  if (!detail) return label;
  return `${label}: ${detail.length > 80 ? `${detail.slice(0, 79)}…` : detail}`;
}

/** Rough upper estimate before a request: cached prefix at read price, plus room for a reply. */
function estimateCost(messages: Turn[], model: string): number {
  const p = priceOf(model);
  const tokens = JSON.stringify(messages).length / 3 + 4000;
  return (tokens * p.input * 0.25 + 2000 * p.output) / 1_000_000;
}

/** "Thu 2026-10-09 18:04", in the brain's local time. */
export function localStamp(d: Date): string {
  const day = d.toLocaleDateString("en-GB", { weekday: "short" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
