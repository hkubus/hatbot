// Your chats (PLAN.md §14): each bot's own, and groups of bots. One Thread runs each; what isn't tied
// to one chat (tasks' messages, what you've seen) is here.
import { type Conversation, HATBOT_ID } from "@hatbot/shared";
import { Thread, type ThreadDeps } from "./thread";

type Parts = Pick<
  ThreadDeps,
  "tasks" | "schedules" | "triggers" | "approvals" | "attachments" | "desktop"
>;

type Row = {
  id: number;
  kind: Conversation["kind"];
  title: string | null;
  bot_ids: string | null;
  unread: number;
  last_message_at: string | null;
};

export class Chats {
  private threads = new Map<number, Thread>();
  private parts: Partial<Parts> = {};
  private clock: () => number;

  constructor(private d: ThreadDeps) {
    this.clock = d.clock ?? Date.now;
    // A restart cuts off any reply that was streaming.
    d.db.query("UPDATE messages SET status = 'error' WHERE status = 'streaming'").run();
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  /** The chat, or null if there's no such one (or it was deleted). */
  thread(conversationId: number): Thread | null {
    const known = this.threads.get(conversationId);
    if (known) return known;
    const exists = this.d.db
      .query("SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL")
      .get(conversationId);
    if (!exists) return null;
    const thread = new Thread({ ...this.d, ...this.parts }, conversationId);
    this.threads.set(conversationId, thread);
    return thread;
  }

  /** A bot's own chat, made the first time it's needed. */
  direct(botId: string): Thread {
    const id =
      this.d.db
        .query<{ id: number }, [string]>(
          `SELECT c.id FROM conversations c JOIN conversation_bots cb ON cb.conversation_id = c.id
           WHERE c.kind = 'direct' AND cb.bot_id = ? ORDER BY c.id LIMIT 1`,
        )
        .get(botId)?.id ??
      this.d.db.transaction(() => {
        const row = this.d.db
          .query<{ id: number }, [string]>(
            "INSERT INTO conversations (kind, created_at) VALUES ('direct', ?) RETURNING id",
          )
          .get(this.now());
        if (!row) throw new Error("conversation insert failed");
        this.d.db
          .query("INSERT INTO conversation_bots (conversation_id, bot_id) VALUES (?, ?)")
          .run(row.id, botId);
        return row.id;
      })();
    return this.thread(id) as Thread;
  }

  /** Hatbot's own chat: what /thread is. */
  hatbot(): Thread {
    return this.direct(HATBOT_ID);
  }

  /** Every bot's own chat, then the groups, newest first. */
  list(): Conversation[] {
    // Every bot has its own chat, even before anything is said in it.
    for (const bot of this.d.bots.list()) this.direct(bot.id);
    return this.d.db
      .query<Row, []>(
        `SELECT c.id, c.kind, c.title,
           (SELECT json_group_array(bot_id) FROM
             (SELECT bot_id FROM conversation_bots WHERE conversation_id = c.id ORDER BY position, bot_id)) AS bot_ids,
           (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'assistant'
             AND m.status != 'streaming' AND m.incognito = 0
             AND (m.seen_at IS NULL OR m.seen_at < coalesce(m.edited_at, m.created_at))) AS unread,
           (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.incognito = 0) AS last_message_at
         FROM conversations c
         WHERE c.deleted_at IS NULL AND (c.kind = 'group' OR EXISTS (
           SELECT 1 FROM conversation_bots cb JOIN bots b ON b.id = cb.bot_id
           WHERE cb.conversation_id = c.id AND b.deleted_at IS NULL))
         ORDER BY c.kind = 'group', c.id`,
      )
      .all()
      .map((r) => this.toConversation(r));
  }

  get(id: number): Conversation | null {
    return this.list().find((c) => c.id === id) ?? null;
  }

  private toConversation(r: Row): Conversation {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      botIds: r.bot_ids ? (JSON.parse(r.bot_ids) as string[]) : [],
      unread: r.unread,
      lastMessageAt: r.last_message_at,
    };
  }

  /** Called once the services that need the chats exist. */
  attach(parts: Parts) {
    Object.assign(this.parts, parts);
    for (const t of this.threads.values()) t.attach(parts);
  }

  /** Every chat that has been opened since the brain started. */
  private open(): Thread[] {
    for (const c of this.list()) this.thread(c.id);
    return [...this.threads.values()];
  }

  /** Pause all: stops every reply in progress. */
  abortAll() {
    for (const t of this.threads.values()) t.abortCurrent();
  }

  /** Summaries and incognito endings, every minute. */
  async sweep() {
    for (const t of this.open()) await t.sweep();
  }

  /** Ends every incognito conversation; the brain does it on start. */
  async endIncognito() {
    for (const t of this.open()) await t.endIncognito();
  }

  /** Waits for every chat's queued replies (tests, shutdown). */
  async idle() {
    await Promise.all([...this.threads.values()].map((t) => t.idle()));
  }

  /** Your bots' messages, in every chat, sent or edited since you last saw them. */
  unread(): number[] {
    return this.d.db
      .query<{ id: number }, []>(
        `SELECT id FROM messages WHERE role = 'assistant' AND status != 'streaming' AND incognito = 0
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
        "UPDATE messages SET edited_at = ? WHERE task_id = ? AND kind IN ('text', 'task', 'command') RETURNING id",
      )
      .all(editedAt, taskId);
    for (const r of rows) this.d.events.emit({ type: "message.edited", id: r.id, editedAt });
  }

  /** Shows a task under the reply that started it, so its progress and result don't need a card. */
  attachTask(messageId: number, taskId: number): boolean {
    const done = this.d.db
      .query(
        "UPDATE messages SET task_id = ? WHERE id = ? AND task_id IS NULL AND kind IN ('text', 'command')",
      )
      .run(taskId, messageId).changes;
    if (done) this.d.events.emit({ type: "message.task", id: messageId, taskId });
    return done > 0;
  }

  /** A card from `botId` in a chat; a deleted one's go to the bot's own. */
  addCard(
    conversationId: number,
    botId: string,
    kind: "task" | "schedule",
    text: string,
    ref: { taskId?: number; scheduleId?: number },
  ) {
    return (this.thread(conversationId) ?? this.direct(botId)).addCard(kind, text, ref, botId);
  }

  /** A task ended: `botId` tells you in the chat it was started from. */
  taskEnded(conversationId: number, botId: string) {
    return (this.thread(conversationId) ?? this.direct(botId)).taskEnded(botId);
  }

  /** Tells the apps a chat's name or bots changed. */
  changed(conversationId: number) {
    const conversation = this.get(conversationId);
    if (conversation) this.d.events.emit({ type: "conversation.updated", conversation });
  }
}
