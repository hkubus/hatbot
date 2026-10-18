// A background task's questions to you (PLAN.md §20): it waits, without the model, for your answer
// from the chat or the task's page, until it runs out of time.
import type { Question } from "@hatbot/shared";
import type { Bots } from "./bots";
import type { Db } from "./db";
import type { EventBus } from "./events";
import type { Notifier } from "./notify";

type Row = {
  id: number;
  bot_id: string;
  task_id: number;
  conversation_id: number | null;
  question: string;
  choices: string;
  status: Question["status"];
  answer: string | null;
  created_at: string;
  expires_at: string;
  answered_at: string | null;
};

const toQuestion = (r: Row): Question => ({
  id: r.id,
  botId: r.bot_id,
  taskId: r.task_id,
  conversationId: r.conversation_id,
  question: r.question,
  choices: JSON.parse(r.choices),
  status: r.status,
  answer: r.answer,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  answeredAt: r.answered_at,
});

export type NewQuestion = {
  botId: string;
  taskId: number;
  conversationId: number | null;
  question: string;
  choices: string[];
  waitMs: number;
};

/** Your answer, or null when there was none in time or the question was dropped. */
export type Answer = string | null;

export class Questions {
  private waiters = new Map<number, (a: Answer) => void>();

  constructor(
    private db: Db,
    private events: EventBus,
    private notifier: Notifier,
    private publicUrl: string,
    private clock: () => number = Date.now,
    private bots?: Bots,
  ) {
    // Nothing waits on questions from before a restart: their tasks were stopped.
    db.query(
      "UPDATE questions SET status = 'cancelled', answered_at = ? WHERE status = 'pending'",
    ).run(this.now());
  }

  private now() {
    return new Date(this.clock()).toISOString();
  }

  get(id: number): Question | null {
    const r = this.db.query<Row, [number]>("SELECT * FROM questions WHERE id = ?").get(id);
    return r ? toQuestion(r) : null;
  }

  pending(): Question[] {
    return this.db
      .query<Row, []>("SELECT * FROM questions WHERE status = 'pending' ORDER BY id")
      .all()
      .map(toQuestion);
  }

  /** How many a task has asked, to keep it from asking all day. */
  countFor(taskId: number): number {
    return (
      this.db
        .query<{ n: number }, [number]>("SELECT count(*) AS n FROM questions WHERE task_id = ?")
        .get(taskId)?.n ?? 0
    );
  }

  create(q: NewQuestion): Question {
    const row = this.db
      .query<{ id: number }, [string, number, number | null, string, string, string, string]>(
        `INSERT INTO questions (bot_id, task_id, conversation_id, question, choices, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        q.botId,
        q.taskId,
        q.conversationId,
        q.question,
        JSON.stringify(q.choices),
        this.now(),
        new Date(this.clock() + q.waitMs).toISOString(),
      );
    const question = this.get(row?.id ?? -1);
    if (!question) throw new Error("question insert failed");
    this.events.emit({ type: "question.created", question });
    void this.notifier.send({
      title: `${this.bots?.nameOf(question.botId) ?? "Hatbot"} asks`,
      message: [question.question, ...question.choices.map((c) => `- ${c}`)].join("\n"),
      priority: 4,
      click: `${this.publicUrl}/tasks/${question.taskId}`,
    });
    return question;
  }

  /** Resolves with the answer, or null when it expires or is dropped. */
  wait(id: number, signal: AbortSignal): Promise<Answer> {
    const current = this.get(id);
    if (current && current.status !== "pending") return Promise.resolve(current.answer);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(id);
        reject(signal.reason);
      };
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.set(id, (a) => {
        signal.removeEventListener("abort", abort);
        resolve(a);
      });
    });
  }

  /** Null when it isn't waiting for one any more. */
  answer(id: number, answer: string): Question | null {
    return this.resolve(id, "answered", answer);
  }

  cancelForTask(taskId: number) {
    const ids = this.db
      .query<{ id: number }, [number]>(
        "SELECT id FROM questions WHERE task_id = ? AND status = 'pending'",
      )
      .all(taskId);
    for (const { id } of ids) this.resolve(id, "cancelled");
  }

  /** Gives up on the ones whose time ran out; the brain calls it every minute. */
  expireDue() {
    const due = this.db
      .query<{ id: number }, [string]>(
        "SELECT id FROM questions WHERE status = 'pending' AND expires_at <= ?",
      )
      .all(this.now());
    for (const { id } of due) this.resolve(id, "expired");
  }

  private resolve(id: number, status: Question["status"], answer: string | null = null) {
    const changed = this.db
      .query(
        "UPDATE questions SET status = ?, answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, answer, this.now(), id);
    if (!changed.changes) return null;
    const question = this.get(id);
    if (question) this.events.emit({ type: "question.resolved", question });
    this.waiters.get(id)?.(answer);
    this.waiters.delete(id);
    return question;
  }
}
