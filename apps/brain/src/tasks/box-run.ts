// T3 Code writes the box in a scratch thread on the owner's computer and sends its files back in its
// last message; the brain builds them as box_create would.
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
import { PluginError } from "../plugins/plugin";
import { runStats, T3Error, type T3Result } from "../t3";
import { askOwner, endOf, Stop } from "./loop";
import type { Tasks } from "./service";

export type BoxJob = { request: string; box?: number; title?: string };

type Saved = { box: Box; note: string; same: boolean };

const RETRIES = 2;
/** What a thread's first message can carry of a box's files, under T3 Code's 120,000 characters. */
const MAX_SEED = 100_000;
const END = "=== END ===";
const MARK = /^=== (FILE|DELETE) (.+) ===$/;

const block = (f: BoxFile) => `=== FILE ${f.path} ===\n${f.content.replace(/\n$/, "")}\n${END}`;

const rules = (guest: boolean) =>
  [
    "You write a box: a small web app that Hatbot's owner keeps and opens from a chat. Hatbot builds and checks it after you're done, so there's nothing to run.",
    BOX_PAGE_RULES,
    guest
      ? BOX_FILES_RULES
      : `There's no boxes guest to build more, so it's one file, ${BOX_PAGE}.`,
    `Hatbot only sees your last message. Start it with a short summary of what you made or changed. Then, for every file you added or changed, a line "=== FILE <path> ===", its whole content, and a line "${END}"; and for every file you removed, a line "=== DELETE <path> ===". No code fences around them, no dotfiles.`,
  ].join("\n\n");

/** What the message says changed, or why it can't be read; null when it names no files. */
function changes(
  text: string,
): { changed: Map<string, string>; gone: Set<string> } | string | null {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const changed = new Map<string, string>();
  const gone = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.trimEnd().match(MARK);
    if (!m) continue;
    const path = (m[2] ?? "").trim();
    if (m[1] === "DELETE") {
      gone.add(path);
      continue;
    }
    const end = lines.findIndex((l, j) => j > i && l.trimEnd() === END);
    if (end < 0) return `${path} has no "${END}" line after it.`;
    const body = lines.slice(i + 1, end);
    changed.set(path, body.length ? `${body.join("\n")}\n` : "");
    i = end;
  }
  return changed.size || gone.size ? { changed, gone } : null;
}

const summaryOf = (text: string) => {
  const at = text.split("\n").findIndex((l) => MARK.test(l.trimEnd()));
  return (at < 0 ? text : text.split("\n").slice(0, at).join("\n")).trim();
};

export async function runBoxTask(tasks: Tasks, id: number, signal: AbortSignal): Promise<void> {
  const { d } = tasks;
  const { boxes, t3 } = d;
  const job = tasks.boxJobOf(id) as BoxJob;
  const task = tasks.get(id) as Task;
  tasks.setStatus(id, "running");

  const taintedBy = () => {
    const t = tasks.get(id);
    return t?.tainted ? t.taintedBy || "What started it" : null;
  };
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
    if (!boxes || !t3?.ready)
      throw new Stop("failed", "T3 Code isn't set up: switch its plugin on in Settings.");
    const box = job.box === undefined ? null : boxes.get(job.box);
    if (job.box !== undefined && !box) throw new Stop("failed", `Box #${job.box} was deleted.`);
    const title = job.title ?? box?.title ?? "Box";
    const guest = Boolean(boxes.backends?.available);
    // Its earlier versions may carry what the work that wrote them read.
    const by = box && boxes.taintedBy(box.id);
    if (box && by) tasks.taint(id, `Box #${box.id} "${box.title}", written after reading: ${by}`);

    const current = box && boxes.page(box.id);
    const before = current ? (current.files ?? [{ path: BOX_PAGE, content: current.html }]) : [];
    const seed = before.map(block).join("\n\n");
    if (seed.length > MAX_SEED)
      throw new Stop(
        "failed",
        `Box #${box?.id}'s files come to more than T3 Code can be handed in one message: change it with box_edit instead.`,
      );
    const files = new Map(before.map((f) => [f.path, f.content]));

    let thread: string | null = null;
    let spent: T3Result | null = null;
    const progress = tasks.progress(id);
    /** Answers why the box can't be saved yet, or null when its files are in hand. */
    const work = async (prompt: string): Promise<string | null> => {
      const r = await t3.run({
        project: null,
        title: `Box: ${title}`,
        prompt,
        thread,
        signal,
        onActivity: progress,
      });
      thread = r.threadId;
      spent = spent ? { ...r, minutes: spent.minutes + r.minutes } : r;
      // Its own account, untrusted: the timeline shows it to you, and the bot never reads it.
      tasks.addStep(id, { kind: "note", name: "T3 Code", detail: summaryOf(r.text), url: null });
      if (!r.ok) throw new Stop("failed", r.text);
      const c = changes(r.text);
      if (typeof c === "string") return c;
      if (!c) return "Your last message has no files in it.";
      for (const path of c.gone) files.delete(path);
      for (const [path, content] of c.changed) files.set(path, content);
      return null;
    };

    const first = [
      rules(guest),
      box
        ? `Change this box, "${box.title}"${job.title && job.title !== box.title ? `, and call it "${job.title}"` : ""}: ${job.request}\n\nIts files now:\n\n${seed}`
        : `Make a box called "${title}": ${job.request}`,
    ].join("\n\n");
    // Not a sandbox: T3 Code can do anything the owner can on their computer.
    if (taintedBy()) {
      const ok = await approve(
        {
          tool: "box_t3",
          input: job,
          what: `T3 Code ${box ? `changes box #${box.id}` : "makes a box"}: ${job.request}`,
          why: "It runs on your computer with full access, after reading outside content.",
        },
        signal,
      );
      if (ok.isError) throw new Stop("failed", ok.content);
    }
    let problem = await work(first);
    for (let tries = 0; ; tries++) {
      const made = problem ?? (await saved());
      if (typeof made !== "string") {
        const b = made.box;
        const stats = spent ? ` (${runStats(spent)})` : "";
        tasks.finish(
          id,
          "done",
          made.same
            ? `T3 Code left box #${b.id} "${b.title}" as it was${stats}.`
            : `T3 Code ${box ? "changed" : "made"} box #${b.id} "${b.title}", now version ${b.version}, shown under your reply${stats}. Look at it with box_look before you tell the owner it's done.${unsetSecrets(ctx, b.id)}${made.note}`,
        );
        return;
      }
      if (tries === RETRIES) throw new Stop("failed", `T3 Code's box wasn't saved: ${made}`);
      tasks.addStep(id, { kind: "note", name: "Not saved yet", detail: made, url: null });
      problem = await work(
        `The box isn't saved yet. ${made}\n\nFix that, then end with a summary and the files you changed since, as before.`,
      );
    }

    async function saved(): Promise<Saved | string> {
      const list = [...files].sort(([a], [b]) => a.localeCompare(b));
      if (!list.length) return "The box has no files left.";
      if (list.length > MAX_BOX_FILES)
        return `A box has at most ${MAX_BOX_FILES} files; there are ${list.length}.`;
      for (const [path] of list) {
        const bad = badPath(path);
        if (bad) return bad;
      }
      const encoder = new TextEncoder();
      if (list.reduce((n, [, c]) => n + encoder.encode(c).length, 0) > MAX_BOX_SOURCE)
        return "A box's files come to at most 2 MB.";
      const all: BoxFile[] = list.map(([path, content]) => ({ path, content }));
      if (!boxes || !d.bots.active(task.botId))
        throw new Stop("cancelled", `${d.bots.nameOf(task.botId)} was deleted.`);
      const made: Made = { messageId: replyOf(tasks, id), taintedBy: taintedBy() };
      const only = all.length === 1 ? all[0] : undefined;
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
        tool: "box_t3",
        id: box?.id,
        title,
        files: all,
        hosts: box ? boxes.hosts(box.id) : [],
        before,
      });
      if (typeof b === "string") return b.replace(/^Not saved: /, "");
      const saved = box
        ? boxes.save(box.id, title, b.page, made, all)
        : boxes.create(
            {
              botId: task.botId,
              conversationId: task.conversationId,
              title,
              html: b.page,
              id: b.id,
              files: all,
            },
            made,
          );
      return shown(saved, b.note);
    }

    function shown(b: Box | null, note: string): Saved | string {
      const now = b ?? (box && boxes?.get(box.id));
      if (!now) return "The box has no files.";
      const reply = replyOf(tasks, id);
      if (reply) boxes?.attach(reply, now.id);
      return { box: now, note, same: !b };
    }
  } catch (err) {
    if (err instanceof T3Error && err.printed) tasks.taint(id, "What T3 Code's agent said");
    const ended =
      !signal.aborted &&
      (err instanceof PluginError || err instanceof NotChanged || err instanceof BoxError)
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
