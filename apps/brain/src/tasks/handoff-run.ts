// ask_bot: the asking bot's request goes to the other bot's own chat, which answers it as it would
// you. That answer, once any task it started has ended, is what the asker hears.
import { ACTIVE_TASK_STATUSES as ACTIVE, type Task } from "@hatbot/shared";
import { endOf } from "./loop";
import type { Tasks } from "./service";

export async function runHandoff(tasks: Tasks, id: number, signal: AbortSignal): Promise<void> {
  const { chats, db, bots } = tasks.d;
  tasks.setStatus(id, "running");
  const task = tasks.get(id) as Task;
  // Where it was asked: the asker's reply it shows under, or its card. A task's hand-off has neither.
  const asking = db
    .query<{ id: number; conversation_id: number }, [number]>(
      "SELECT id, conversation_id FROM messages WHERE task_id = ? AND kind IN ('text', 'command', 'task') ORDER BY id LIMIT 1",
    )
    .get(id);
  const thread = chats.direct(task.botId);
  const { message, answer } = thread.handoff(
    task,
    asking ? { conversationId: asking.conversation_id, messageId: asking.id } : null,
    signal,
  );
  if (asking)
    chats.link(asking.id, { conversationId: thread.conversationId, messageId: message.id });
  signal.addEventListener("abort", () => thread.stopHandoff(message.id), { once: true });
  let answered: number | null = null;
  try {
    const said = await untilAborted(answer, signal);
    if (!said) return tasks.finish(id, "cancelled", `${bots.nameOf(task.botId)} was deleted.`);
    answered = said.id;
    // A task the answer started (run_task, or another hand-off): its bot writes the answer again
    // when it ends, and that's the answer. It may start another.
    const under = () => {
      const t = thread.message(said.id)?.taskId;
      return t ? tasks.get(t) : null;
    };
    let sub = under();
    while (sub) {
      if (ACTIVE.includes(sub.status)) await tasks.waitFor(sub.id, signal);
      await untilAborted(thread.idle(), signal);
      const next = under();
      if (next?.id === sub.id) break;
      sub = next;
    }
    sub = under();
    const m = thread.message(said.id);
    const name = bots.nameOf(task.botId);
    const { tainted, suspected } = await thread.endHandoff(said.id);
    if (tainted) tasks.taint(id, `${name}'s chat had read: ${tainted}`);
    else if (sub?.tainted) tasks.taint(id, `Task #${sub.id} by ${name}`);
    if (suspected) tasks.mark(id, "injection_suspected");
    // Its task cancelled, the answer is what it said before it, which waited for the task.
    if (sub?.status === "cancelled")
      return tasks.finish(id, "cancelled", `${name}'s task #${sub.id} was cancelled.`, false);
    tasks.finish(
      id,
      said.stopped ? "cancelled" : m?.status === "error" ? "failed" : "done",
      m?.text.trim() || "No answer.",
      false,
    );
  } catch (err) {
    // Cancelled: so is a task its answer started, now or once the answer has stopped.
    if (signal.aborted) {
      const cancelUnder = (answerId: number) => {
        const under = thread.message(answerId)?.taskId;
        if (under) tasks.cancel(under);
      };
      if (answered !== null) cancelUnder(answered);
      else
        void answer.then(
          (s) => s && cancelUnder(s.id),
          () => {},
        );
    }
    void thread.endHandoff(answered);
    const ended = endOf(err, id, signal);
    tasks.finish(id, ended.status, ended.summary, ended.notify);
  }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
