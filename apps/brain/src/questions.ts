// A background task's questions to you: it waits, without the model, for your answer from the chat
// or the task's page, until it runs out of time.
import { createHmac } from "node:crypto";
import type { Question } from "@hatbot/shared";
import { sameText, secretKey } from "./auth/keys";
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
  sources: string;
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
  sources: JSON.parse(r.sources),
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
  sources: string[];
  waitMs: number;
};

/** Your answer, or null when there was none in time or the question was dropped. */
export type Answer = string | null;

/** ntfy shows at most 3 buttons: a question with more choices is answered in the app. */
const MAX_BUTTONS = 3;

export class Questions {
  private waiters = new Map<number, (a: Answer) => void>();
  private key: Buffer;

  constructor(
    private db: Db,
    private events: EventBus,
    private notifier: Notifier,
    private publicUrl: string,
    private clock: () => number = Date.now,
    private bots?: Bots,
  ) {
    this.key = secretKey(db, "question_key");
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

  create(q: NewQuestion): Question {
    const row = this.db
      .query<
        { id: number },
        [string, number, number | null, string, string, string, string, string]
      >(
        `INSERT INTO questions (bot_id, task_id, conversation_id, question, choices, sources, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        q.botId,
        q.taskId,
        q.conversationId,
        q.question,
        JSON.stringify(q.choices),
        JSON.stringify(q.sources),
        this.now(),
        new Date(this.clock() + q.waitMs).toISOString(),
      );
    const question = this.get(row?.id ?? -1);
    if (!question) throw new Error("question insert failed");
    this.events.emit({ type: "question.created", question });
    void this.notify(question);
    return question;
  }

  private async notify(q: Question) {
    const exp = Math.floor(Date.parse(q.expiresAt) / 1000);
    const buttons = q.choices.length <= MAX_BUTTONS;
    await this.notifier.send({
      title: `${this.bots?.nameOf(q.botId) ?? "Hatbot"} asks`,
      message: [
        q.question,
        ...(buttons ? [] : q.choices.map((c) => `- ${c}`)),
        ...(q.sources.length ? [`After reading ${q.sources.join(", ")}`] : []),
      ].join("\n"),
      priority: 4,
      click: `${this.publicUrl}/tasks/${q.taskId}`,
      ...(buttons && q.choices.length
        ? {
            actions: q.choices.map((label, choice) => ({
              action: "http" as const,
              label,
              url: `${this.publicUrl}/api/v1/questions/${q.id}/token-answer`,
              method: "POST" as const,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ choice, exp, sig: this.sign(q.id, choice, exp) }),
              clear: true,
            })),
          }
        : {}),
    });
  }

  sign(id: number, choice: number, exp: number): string {
    return createHmac("sha256", this.key).update(`${id}:${choice}:${exp}`).digest("base64url");
  }

  /**
   * A notification's button: the choice its signature stands for, while the link holds. Undefined when
   * the signature or time is wrong, null when it isn't waiting any more.
   */
  answerByToken(id: number, choice: number, exp: number, sig: string): Question | null | undefined {
    if (exp * 1000 < this.clock() || !sameText(sig, this.sign(id, choice, exp))) return undefined;
    const label = this.get(id)?.choices[choice];
    return label === undefined ? undefined : this.answer(id, label);
  }

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
