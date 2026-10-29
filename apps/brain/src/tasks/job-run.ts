// A plugin's job runs the task itself; the core gives it approvals as a write's, and ends it.

import { type JobRun, JobStop, PluginError } from "@hatbot/plugin-sdk";
import type { Task } from "@hatbot/shared";
import { blockedText, levelOf, safeToRun } from "../agent/review";
import { ownerNote } from "../approvals";
import { askOwner, endOf, Stop } from "./loop";
import type { Tasks } from "./service";

export async function runJob(tasks: Tasks, id: number, signal: AbortSignal): Promise<void> {
  const { d } = tasks;
  const task = tasks.get(id) as Task;
  tasks.setStatus(id, "running");

  const tainted = () => {
    const t = tasks.get(id);
    return t?.tainted ? t.taintedBy || "What started it" : null;
  };
  const approve: JobRun["approve"] = async ({ why, always, ...call }, sig) => {
    const verdict = { action: "ask" as const, why, tainted: true, always };
    const by = tainted();
    const sources = by ? [by] : [];
    const level = levelOf(d.settings.get(), verdict);
    if (level === "allow") return { content: "", isError: false };
    if (level === "review") {
      if (d.approvals.granted({ botId: task.botId, ...call, target: null, taskId: id }))
        return { content: "", isError: false };
      const check = await safeToRun(
        d,
        { taskId: id },
        { ownerSaid: tasks.requestOf(id), goal: task.goal, sources },
        { ...call, why },
      );
      if (check.safe) {
        tasks.addStep(id, {
          kind: "approval",
          name: `Not asking: ${check.by} found it safe`,
          detail: check.why ? `${call.what}. ${check.why}` : call.what,
          url: null,
        });
        return { content: "", isError: false };
      }
      d.approvals.block({
        taskId: id,
        botId: task.botId,
        kind: "other",
        summary: call.what,
        reason: `${check.by}: ${check.why}`,
        sources,
        call: { tool: call.tool, input: call.input, target: null },
      });
      tasks.addStep(id, {
        kind: "approval",
        name: `Blocked: ${check.by} found it unsafe`,
        detail: `${call.what}. ${check.why}`,
        url: null,
      });
      return { content: blockedText(check.why), isError: true };
    }
    const answer = await askOwner(
      tasks,
      id,
      { botId: task.botId, kind: "other", summary: call.what, reason: why, sources },
      null,
      (wait) => {
        tasks.setStatus(id, "waiting_approval");
        return wait().finally(() => tasks.setStatus(id, "running"));
      },
      sig,
    );
    const note = answer.note ? ` ${ownerNote(answer.note)}` : "";
    return answer.outcome === "approved"
      ? { content: note && `\n\n${note.trim()}`, isError: false }
      : { content: `Not done: the owner said no.${note}`, isError: true };
  };

  try {
    const job = task.runner ? d.plugins.job(task.runner) : null;
    if (!job)
      throw new Stop("failed", `Stopped: the plugin that runs "${task.runner}" tasks is off.`);
    const summary = await job.run({
      task,
      input: tasks.jobOf(id),
      signal,
      tainted,
      taint: (by) => tasks.taint(id, by),
      approve,
      progress: tasks.progress(id),
      reply: () => replyOf(tasks, id),
    });
    tasks.finish(id, "done", summary);
  } catch (err) {
    const ended =
      !signal.aborted && err instanceof JobStop
        ? { status: err.status, summary: err.summary }
        : !signal.aborted && err instanceof PluginError
          ? { status: "failed" as const, summary: err.message }
          : endOf(err, id, signal);
    tasks.finish(id, ended.status, ended.summary, ended.notify);
  } finally {
    d.approvals.cancelForTask(id);
  }
}

const replyOf = (tasks: Tasks, id: number) =>
  tasks.d.db
    .query<{ id: number }, [number]>(
      "SELECT id FROM messages WHERE task_id = ? AND kind IN ('text', 'command') ORDER BY id LIMIT 1",
    )
    .get(id)?.id ?? null;
