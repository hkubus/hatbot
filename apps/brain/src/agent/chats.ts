import {
  type Box,
  type Conversation,
  HATBOT_ID,
  MAX_OPEN_THREADS,
  type MessageLink,
  type Task,
  type ThreadMessage,
  UNREAD_PER_CHAT,
} from "@hatbot/shared";
import { BotError } from "../bots";
import { UserError } from "../errors";
import { resultText, Thread, type ThreadDeps } from "./thread";

type Parts = Pick<ThreadDeps, "tasks" | "approvals" | "attachments" | "negotiations" | "proposals">;

/** Must stay word for word messages_unread's condition. */
const UNREAD = `role = 'assistant' AND status != 'streaming' AND incognito = 0
  AND (seen_at IS NULL OR seen_at < coalesce(edited_at, created_at))`;

export const LISTED_CHAT = `c.deleted_at IS NULL AND (c.kind = 'group' OR EXISTS (
  SELECT 1 FROM conversation_bots cb JOIN bots b ON b.id = cb.bot_id
  WHERE cb.conversation_id = c.id AND b.deleted_at IS NULL))`;

type Row = {
  id: number;
  kind: Conversation["kind"];
  title: string | null;
  bot_ids: string | null;
  unread: number;
  last_message_at: string | null;
  parent_id: number | null;
  resolved_at: string | null;
  outcome: string | null;
};

export class Chats {
  private running = new Map<number, Thread>();
  /** Shared by every chat, so what attach adds reaches the chats open already. */
  private d: ThreadDeps;
  private clock: () => number;

  constructor(d: ThreadDeps) {
    this.d = { ...d, chats: this };
    this.clock = d.clock ?? Date.now;
    // A restart cuts off any reply that was streaming: it keeps what was saved of it, and says so.
    const note = "_This reply was cut off._";
    d.db
      .query(
        `UPDATE messages SET status = 'error',
         text = CASE WHEN text = '' THEN ?1 ELSE text || ?2 END WHERE status = 'streaming'`,
      )
      .run(note, `\n\n---\n\n${note}`);
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  thread(conversationId: number): Thread | null {
    const known = this.running.get(conversationId);
    if (known) return known;
    const exists = this.d.db
      .query("SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL")
      .get(conversationId);
    if (!exists) return null;
    const thread = new Thread(this.d, conversationId);
    this.running.set(conversationId, thread);
    return thread;
  }

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

  hatbot(): Thread {
    return this.direct(HATBOT_ID);
  }

  list(): Conversation[] {
    // Every bot has its own chat, even before anything is said in it.
    for (const bot of this.d.bots.list()) this.direct(bot.id);
    return this.rows(`${LISTED_CHAT} AND c.kind != 'thread'`, "c.kind = 'group', c.id");
  }

  /** A chat's threads, the open ones first, then by their latest message. */
  threads(parentId: number): Conversation[] {
    return this.rows(
      `${LISTED_CHAT} AND c.parent_id = ?1`,
      "c.resolved_at IS NOT NULL, coalesce(last_message_at, c.created_at) DESC",
      parentId,
    );
  }

  private rows(where: string, order: string, ...args: number[]): Conversation[] {
    return this.d.db
      .query<Row, number[]>(
        `SELECT c.id, c.kind, c.title, c.parent_id, c.resolved_at, c.outcome,
           (SELECT json_group_array(bot_id) FROM
             (SELECT bot_id FROM conversation_bots WHERE conversation_id = c.id ORDER BY position, bot_id)) AS bot_ids,
           coalesce(u.n, 0) AS unread,
           -- Ids go up with time: the newest one's time, from the index rather than every row.
           (SELECT created_at FROM messages WHERE id = (SELECT max(id) FROM messages m
             WHERE m.conversation_id = c.id AND m.incognito = 0)) AS last_message_at
         FROM conversations c
         LEFT JOIN (SELECT conversation_id, count(*) AS n FROM messages WHERE ${UNREAD} GROUP BY conversation_id) u
           ON u.conversation_id = c.id
         WHERE ${where}
         ORDER BY ${order}`,
      )
      .all(...args)
      .map((r) => this.toConversation(r));
  }

  get(id: number): Conversation | null {
    return this.rows(`${LISTED_CHAT} AND c.id = ?1`, "c.id", id)[0] ?? null;
  }

  /** A deleted bot's own chat: kept, but out of the list, and it takes no new messages. */
  closed(conversationId: number): boolean {
    return Boolean(
      this.d.db
        .query(
          `SELECT 1 FROM conversations c JOIN conversation_bots cb ON cb.conversation_id = c.id
           JOIN bots b ON b.id = cb.bot_id
           WHERE c.id = ? AND c.kind != 'group' AND b.deleted_at IS NOT NULL`,
        )
        .get(conversationId),
    );
  }

  private toConversation(r: Row): Conversation {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      botIds: r.bot_ids ? (JSON.parse(r.bot_ids) as string[]) : [],
      unread: r.unread,
      lastMessageAt: r.last_message_at,
      parentId: r.parent_id,
      resolvedAt: r.resolved_at,
      outcome: r.outcome,
    };
  }

  /**
   * A thread in `botId`'s own chat, opened with the bot's first message in it; its card goes in that
   * chat. `taintedBy`: the message was written after reading untrusted content.
   */
  openThread(o: { botId: string; title: string; message: string; taintedBy?: string | null }): {
    conversation: Conversation;
    message: ThreadMessage;
  } {
    const parent = this.direct(o.botId);
    const open = this.d.db
      .query<{ n: number }, [number]>(
        "SELECT count(*) AS n FROM conversations WHERE parent_id = ? AND resolved_at IS NULL AND deleted_at IS NULL",
      )
      .get(parent.conversationId)?.n;
    if ((open ?? 0) >= MAX_OPEN_THREADS)
      throw new UserError(
        `Not opened: ${MAX_OPEN_THREADS} threads are open already. Resolve some first.`,
      );
    const id = this.d.db.transaction(() => {
      const row = this.d.db
        .query<{ id: number }, [string, number, string]>(
          "INSERT INTO conversations (kind, title, parent_id, created_at) VALUES ('thread', ?, ?, ?) RETURNING id",
        )
        .get(o.title, parent.conversationId, this.now());
      if (!row) throw new Error("conversation insert failed");
      this.setBots(row.id, [o.botId]);
      return row.id;
    })();
    const thread = this.thread(id) as Thread;
    const message = thread.add({ text: o.message, botId: o.botId, taintedBy: o.taintedBy });
    parent.add({
      kind: "thread",
      text: o.title,
      botId: o.botId,
      link: { conversationId: id, messageId: message.id },
      taintedBy: o.taintedBy,
    });
    this.changed(id);
    return { conversation: this.get(id) as Conversation, message };
  }

  /** `outcome` null: you resolved it. */
  resolveThread(id: number, outcome: string | null): Conversation | null {
    const done = this.d.db
      .query(
        "UPDATE conversations SET resolved_at = ?, outcome = ? WHERE id = ? AND kind = 'thread' AND resolved_at IS NULL",
      )
      .run(this.now(), outcome, id).changes;
    if (done) this.changed(id);
    return this.get(id);
  }

  /**
   * What a thread read: its first message's taint (it was written after reading untrusted content),
   * or, unless `openerOnly`, what any of its conversations read since.
   */
  threadTaint(id: number, openerOnly = false): string | null {
    const opener = this.d.db
      .query<{ by: string | null }, [number]>(
        "SELECT tainted_by AS by FROM messages WHERE conversation_id = ? ORDER BY id LIMIT 1",
      )
      .get(id)?.by;
    if (opener || openerOnly) return opener ?? null;
    return (
      this.d.db
        .query<{ by: string }, [number]>(
          "SELECT coalesce(tainted_by, 'Untrusted content') AS by FROM episodes WHERE conversation_id = ? AND tainted = 1 ORDER BY id LIMIT 1",
        )
        .get(id)?.by ?? null
    );
  }

  reopenThread(id: number) {
    const done = this.d.db
      .query(
        "UPDATE conversations SET resolved_at = NULL, outcome = NULL WHERE id = ? AND kind = 'thread' AND resolved_at IS NOT NULL",
      )
      .run(id).changes;
    if (done) this.changed(id);
  }

  attach(parts: Parts) {
    Object.assign(this.d, parts);
  }

  private open(): Thread[] {
    for (const c of this.list()) this.thread(c.id);
    return [...this.running.values()];
  }

  abortAll() {
    for (const t of this.running.values()) t.abortCurrent();
  }

  abortBot(botId: string) {
    for (const t of this.running.values()) t.abortCurrent(botId);
  }

  async sweep() {
    for (const t of this.open()) await t.sweep();
  }

  async endIncognito() {
    for (const t of this.open()) await t.endIncognito();
  }

  async idle() {
    await Promise.all([...this.running.values()].map((t) => t.idle()));
  }

  /**
   * Capped per chat: a bot's chat never read had thousands. Pinned to messages_unread: SQLite
   * otherwise picks messages_conversation and walks a long chat's read messages.
   */
  unread(): number[] {
    return this.d.db
      .query<{ id: number }, [number]>(
        `SELECT u.id FROM conversations c JOIN messages u ON u.id IN (SELECT id FROM messages INDEXED BY messages_unread
           WHERE conversation_id = c.id AND ${UNREAD} ORDER BY id DESC LIMIT ?1)
         ORDER BY u.id`,
      )
      .all(UNREAD_PER_CHAT)
      .map((r) => r.id);
  }

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

  markEdited(taskId: number) {
    const editedAt = this.now();
    const rows = this.d.db
      .query<{ id: number }, [string, number]>(
        "UPDATE messages SET edited_at = ? WHERE task_id = ? AND kind IN ('text', 'task', 'command') RETURNING id",
      )
      .all(editedAt, taskId);
    for (const r of rows) this.d.events.emit({ type: "message.edited", id: r.id, editedAt });
  }

  endReply(task: Task, rewrite: boolean) {
    const rows = this.d.db
      .query<
        { id: number; text: string; status: "done" | "error" | "streaming" },
        [string, number]
      >(
        `UPDATE messages SET text = ?, status = CASE WHEN ${rewrite ? 1 : 0} THEN 'streaming' ELSE status END
         WHERE task_id = ? AND kind IN ('text', 'command') AND status != 'streaming' RETURNING id, text, status`,
      )
      .all(rewrite ? "" : resultText(task), task.id);
    for (const r of rows)
      this.d.events.emit(
        r.status === "streaming"
          ? { type: "message.rewrite", id: r.id }
          : { type: "message.done", id: r.id, text: r.text, status: r.status },
      );
  }

  attachTask(messageId: number, taskId: number): boolean {
    const done = this.d.db
      .query(
        "UPDATE messages SET task_id = ? WHERE id = ? AND task_id IS NULL AND kind IN ('text', 'command')",
      )
      .run(taskId, messageId).changes;
    if (done) this.d.events.emit({ type: "message.task", id: messageId, taskId });
    return done > 0;
  }

  /** A hand-off's asking message now links to its request in the other bot's chat. */
  link(messageId: number, link: MessageLink) {
    this.d.db
      .query("UPDATE messages SET link_conversation_id = ?, link_message_id = ? WHERE id = ?")
      .run(link.conversationId, link.messageId, messageId);
    this.d.events.emit({ type: "message.link", id: messageId, link });
  }

  /** A deleted chat's cards go to the bot's own. */
  addCard(
    conversationId: number,
    botId: string,
    kind: "task" | "schedule",
    text: string,
    ref: { taskId?: number; scheduleId?: number },
  ) {
    return (this.thread(conversationId) ?? this.direct(botId)).add({ kind, text, ...ref, botId });
  }

  /** `taintedBy`: the text came from untrusted content; a conversation that reads it is tainted. */
  note(botId: string, text: string, taintedBy: string | null = null) {
    return this.direct(botId).add({ text, botId, taintedBy });
  }

  /** The box's code wrote it, so it's untrusted: never your words, nor the bot's. */
  boxNote(box: Box, text: string) {
    const made = box.conversationId === null ? null : this.thread(box.conversationId);
    const thread =
      made?.members().some((b) => b.id === box.botId) && !this.closed(box.conversationId ?? 0)
        ? made
        : this.direct(box.botId);
    return thread.add({
      kind: "box",
      text,
      botId: box.botId,
      boxId: box.id,
      taintedBy: `Box #${box.id} "${box.title}"`,
    });
  }

  taskEnded(conversationId: number, botId: string) {
    return (this.thread(conversationId) ?? this.direct(botId)).taskEnded(botId);
  }

  createGroup(title: string | undefined, botIds: string[]): Conversation {
    const ids = this.groupBots(botIds);
    const id = this.d.db.transaction(() => {
      const row = this.d.db
        .query<{ id: number }, [string | null, string]>(
          "INSERT INTO conversations (kind, title, created_at) VALUES ('group', ?, ?) RETURNING id",
        )
        .get(title || null, this.now());
      if (!row) throw new Error("conversation insert failed");
      this.setBots(row.id, ids);
      return row.id;
    })();
    this.changed(id);
    return this.get(id) as Conversation;
  }

  updateGroup(id: number, patch: { title?: string; botIds?: string[] }): Conversation | null {
    if (this.get(id)?.kind !== "group") return null;
    const ids = patch.botIds && this.groupBots(patch.botIds);
    this.d.db.transaction(() => {
      if (patch.title !== undefined)
        this.d.db
          .query("UPDATE conversations SET title = ? WHERE id = ?")
          .run(patch.title || null, id);
      if (ids) {
        this.d.db.query("DELETE FROM conversation_bots WHERE conversation_id = ?").run(id);
        this.setBots(id, ids);
      }
    })();
    this.changed(id);
    return this.get(id);
  }

  deleteGroup(id: number): boolean {
    if (this.get(id)?.kind !== "group") return false;
    this.running.get(id)?.abortCurrent();
    this.running.delete(id);
    this.d.db.query("UPDATE conversations SET deleted_at = ? WHERE id = ?").run(this.now(), id);
    this.d.events.emit({ type: "conversation.deleted", id });
    return true;
  }

  private groupBots(botIds: string[]): string[] {
    const ids = [...new Set(botIds)];
    const missing = ids.find((b) => !this.d.bots.active(b));
    if (missing) throw new BotError(`No bot "${missing}".`);
    if (ids.length < 2) throw new BotError("A group needs at least two bots.");
    return ids;
  }

  private setBots(id: number, botIds: string[]) {
    const add = this.d.db.query(
      "INSERT INTO conversation_bots (conversation_id, bot_id, position) VALUES (?, ?, ?)",
    );
    for (const [i, b] of botIds.entries()) add.run(id, b, i);
  }

  changed(conversationId: number) {
    const conversation = this.get(conversationId);
    if (conversation) this.d.events.emit({ type: "conversation.updated", conversation });
  }
}
