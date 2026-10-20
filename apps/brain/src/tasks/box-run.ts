// A box made or changed by Claude Code (box_claude, PLAN.md §21): a task under the reply that asked for
// it. Claude Code writes the box's files in a folder of the sandbox, with no tool that runs anything;
// the brain builds what it leaves there as box_create would, hands what's wrong back to it, and saves
// the box under the reply. The bot hears how it went as it hears of any task it started.
import type { Box, Task } from "@hatbot/shared";
import { MAX_BOX_HTML } from "@hatbot/shared";
import {
  BOX_PAGE,
  type BoxFile,
  badPath,
  MAX_BOX_FILES,
  MAX_BOX_SOURCE,
} from "@hatbot/shared/hatbox";
import { mayReview, safeToRun } from "../agent/review";
import {
  BOX_FILES_RULES,
  BOX_PAGE_RULES,
  builtBox,
  NotChanged,
  type ToolContext,
  unsetSecrets,
} from "../agent/tools";
import { ownerNote } from "../approvals";
import { BoxError, type Made } from "../boxes";
import { ClaudeCodeError, type ClaudeResult, runStats } from "../claude-code";
import { PluginError } from "../plugins/plugin";
import { askOwner, endOf, Stop } from "./loop";
import type { Tasks } from "./service";

/** What box_claude asked for: a new box, or a change to `box`. */
export type BoxJob = { request: string; box?: number; title?: string };

/** The box as saved, with an approval's note; `same` when Claude Code left it as it was. */
type Saved = { box: Box; note: string; same: boolean };

/** Times what's wrong with the box goes back to Claude Code before the task fails. */
const RETRIES = 2;

/** Its tools: files only. The box runs on the boxes guest, never here. */
const TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

const system = (guest: boolean) =>
  [
    "You write a box: a small web app that Hatbot's owner keeps and opens from a chat. Its files are the working directory: write them there, with no dotfiles. Nothing is run here, so don't try to; it's built and checked after you're done.",
    BOX_PAGE_RULES,
    guest
      ? BOX_FILES_RULES
      : `There's no boxes guest to build more, so it's one file, ${BOX_PAGE}.`,
    "End with a short summary of what you made or changed.",
  ].join("\n\n");

/** Lists the folder's files, with their sizes, as JSON: no dotfiles or links, at most 200. */
const listing = (dir: string) =>
  `python3 -c 'import os,sys,json
r=sys.argv[1];out=[]
for d,ds,fs in os.walk(r):
 ds[:]=[x for x in ds if not x.startswith(".") and not os.path.islink(os.path.join(d,x))]
 for f in fs:
  p=os.path.join(d,f)
  if not f.startswith(".") and os.path.isfile(p) and not os.path.islink(p): out.append([os.path.relpath(p,r),os.path.getsize(p)])
print(json.dumps(sorted(out)[:200]))' '${dir}'`;

export async function runBoxTask(tasks: Tasks, id: number, signal: AbortSignal): Promise<void> {
  const { d } = tasks;
  const { boxes, claude } = d;
  const agent = d.desktop.agent;
  const sandbox = agent.withSignal?.(signal) ?? agent;
  const job = tasks.boxJobOf(id) as BoxJob;
  const task = tasks.get(id) as Task;
  const dir = `boxes/task-${id}`;
  const key = `task-${id}`;
  tasks.setStatus(id, "running");

  /** What the task has read that it doesn't trust, now. */
  const taintedBy = () => {
    const t = tasks.get(id);
    return t?.tainted ? t.taintedBy || "What started it" : null;
  };
  /** A change that would ask, as a task's does: Haiku's review, then you. */
  const approve: ToolContext["approve"] = async ({ why, always, ...call }, sig) => {
    const verdict = { action: "ask" as const, why, tainted: true, always };
    const by = taintedBy();
    const sources = by ? [by] : [];
    const suspected = tasks.get(id)?.injectionSuspected ?? false;
    if (d.settings.get().reviewChanges && mayReview(verdict, suspected)) {
      const check = await safeToRun(
        d,
        { taskId: id },
        { ownerSaid: tasks.requestOf(id), goal: task.goal, sources },
        { ...call, why },
      );
      if (check.safe) {
        tasks.addStep(id, {
          kind: "approval",
          name: "Not asking: Haiku found it safe",
          detail: check.why ? `${call.what}. ${check.why}` : call.what,
          url: null,
        });
        return { content: "", isError: false };
      }
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
      : { content: `Not saved: the owner said no.${note}`, isError: true };
  };
  const ctx: ToolContext = {
    ...tasks.toolContext(task, signal),
    boxes,
    tainted: taintedBy,
    taint: (by) => tasks.taint(id, by),
    approve,
  };

  try {
    if (!boxes || !claude?.ready)
      throw new Stop("failed", "Claude Code isn't set up: switch its plugin on in Settings.");
    const box = job.box === undefined ? null : boxes.get(job.box);
    if (job.box !== undefined && !box) throw new Stop("failed", `Box #${job.box} was deleted.`);
    const title = job.title ?? box?.title ?? "Box";
    const guest = Boolean(boxes.backends?.available);
    // Its earlier versions may carry what the work that wrote them read.
    const by = box && boxes.taintedBy(box.id);
    if (box && by) tasks.taint(id, `Box #${box.id} "${box.title}", written after reading: ${by}`);

    // Its folder, with the box's files as they are.
    const seeded = await sandbox.exec(`rm -rf -- '${dir}' && mkdir -p -- '${dir}'`, 30);
    if (seeded.exitCode !== 0) throw new PluginError(`Couldn't make ${dir} in the sandbox.`);
    const current = box && boxes.page(box.id);
    const before = current ? (current.files ?? [{ path: BOX_PAGE, content: current.html }]) : [];
    for (const f of before)
      await sandbox.putFile(`${dir}/${f.path}`, new TextEncoder().encode(f.content));

    let session: string | null = null;
    let spent: ClaudeResult | null = null;
    const progress = tasks.progress(id);
    const work = async (prompt: string) => {
      const r = await claude.run({
        dir,
        prompt,
        system: system(guest),
        tools: TOOLS,
        resume: session,
        key,
        signal,
        onActivity: progress,
      });
      session = r.sessionId ?? session;
      spent = spent
        ? {
            ...r,
            minutes: spent.minutes + r.minutes,
            turns: spent.turns + r.turns,
            costUsd: spent.costUsd + r.costUsd,
          }
        : r;
      // Its own account, untrusted: the timeline shows it to you, and the bot never reads it.
      tasks.addStep(id, { kind: "note", name: "Claude Code", detail: r.text, url: null });
      if (!r.ok) throw new Stop("failed", r.text);
    };

    await work(
      box
        ? `Change this box, "${box.title}", whose files are here${job.title && job.title !== box.title ? `, and call it "${job.title}"` : ""}: ${job.request}`
        : `Make a box called "${title}": ${job.request}`,
    );
    for (let tries = 0; ; tries++) {
      const made = await saved();
      if (typeof made !== "string") {
        const b = made.box;
        const stats = spent ? ` (${runStats(spent)})` : "";
        tasks.finish(
          id,
          "done",
          made.same
            ? `Claude Code left box #${b.id} "${b.title}" as it was${stats}.`
            : `Claude Code ${box ? "changed" : "made"} box #${b.id} "${b.title}", now version ${b.version}, shown under your reply${stats}. Look at it with box_look before you tell the owner it's done.${unsetSecrets(ctx, b.id)}${made.note}`,
        );
        return;
      }
      if (tries === RETRIES) throw new Stop("failed", `Claude Code's box wasn't saved: ${made}`);
      tasks.addStep(id, { kind: "note", name: "Not saved yet", detail: made, url: null });
      await work(`The box isn't saved yet. ${made}\n\nFix that, then sum up again.`);
    }

    /** The box saved from what Claude Code left, with an approval's note; or what's wrong, for it. */
    async function saved(): Promise<Saved | string> {
      const found = await sandbox.exec(listing(dir), 60);
      let list: [string, number][];
      try {
        list = JSON.parse(found.output);
      } catch {
        throw new PluginError(`Couldn't list the files in ${dir}.`);
      }
      if (!list.length) return `There are no files in the working directory: write the box there.`;
      if (list.length > MAX_BOX_FILES)
        return `A box has at most ${MAX_BOX_FILES} files; there are ${list.length}.`;
      for (const [path] of list) {
        const bad = badPath(path);
        if (bad) return bad;
      }
      if (list.reduce((n, [, size]) => n + size, 0) > MAX_BOX_SOURCE)
        return "A box's files come to at most 2 MB.";
      const files: BoxFile[] = [];
      for (const [path] of list) {
        const bytes = await sandbox.getFile(`${dir}/${path}`);
        try {
          files.push({ path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
        } catch {
          return `${path} isn't text.`;
        }
      }
      if (!boxes || !d.bots.active(task.botId))
        throw new Stop("cancelled", `${d.bots.nameOf(task.botId)} was deleted.`);
      const made: Made = { messageId: replyOf(tasks, id), taintedBy: taintedBy() };
      const only = files.length === 1 ? files[0] : undefined;
      const page = only?.path === BOX_PAGE ? only.content : null;
      if (page !== null) {
        if (page.length > MAX_BOX_HTML) return `${BOX_PAGE} is too long: at most 1 MB.`;
        const b = box
          ? boxes.save(box.id, title, page, made)
          : boxes.create(
              { botId: task.botId, conversationId: task.conversationId, title, html: page },
              made,
            );
        return shown(b, "");
      }
      if (!guest)
        return `Without the boxes guest a box is one file, ${BOX_PAGE}: put everything in it.`;
      const b = await builtBox(ctx, signal, {
        tool: "box_claude",
        id: box?.id,
        title,
        files,
        hosts: box ? boxes.hosts(box.id) : [],
        before,
      });
      if (typeof b === "string") return b.replace(/^Not saved: /, "");
      const saved = box
        ? boxes.save(box.id, title, b.page, made, files)
        : boxes.create(
            {
              botId: task.botId,
              conversationId: task.conversationId,
              title,
              html: b.page,
              id: b.id,
              files,
            },
            made,
          );
      return shown(saved, b.note);
    }

    /** Shows the box under the reply; one left as it was (`b` null) too. */
    function shown(b: Box | null, note: string): Saved | string {
      const now = b ?? (box && boxes?.get(box.id));
      if (!now) return `${dir} is empty.`;
      const reply = replyOf(tasks, id);
      if (reply) boxes?.attach(reply, now.id);
      return { box: now, note, same: !b };
    }
  } catch (err) {
    if (err instanceof ClaudeCodeError && err.printed) tasks.taint(id, "What Claude Code printed");
    const ended =
      !signal.aborted &&
      (err instanceof PluginError || err instanceof NotChanged || err instanceof BoxError)
        ? { status: "failed" as const, summary: err.message }
        : endOf(err, id, signal);
    tasks.finish(id, ended.status, ended.summary, ended.notify);
  } finally {
    // Not on the task's signal: a cancelled task's folder goes too.
    await agent.exec(`rm -rf -- '${dir}'`, 60).catch(() => {});
    await claude?.forget(key);
    d.approvals.cancelForTask(id);
  }
}

/** The reply the task shows under. */
const replyOf = (tasks: Tasks, id: number) =>
  tasks.d.db
    .query<{ id: number }, [number]>(
      "SELECT id FROM messages WHERE task_id = ? AND kind IN ('text', 'command') ORDER BY id LIMIT 1",
    )
    .get(id)?.id ?? null;
