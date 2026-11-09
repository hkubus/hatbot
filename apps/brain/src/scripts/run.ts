// Runs a script's steps as a task, without the model. A change runs through its tool's policy like a
// task's, but the script's approval stands in for the review: only what always asks you still does.

import { type CallContext, JobStop, type PluginTool } from "@hatbot/plugin-sdk";
import {
  HATBOT_ID,
  type ScriptCondition,
  type ScriptJob,
  type ScriptStep,
  stepsIn,
  type Task,
} from "@hatbot/shared";
import { levelOf, scopable } from "../agent/review";
import { describeCall, offered, runPluginTool, verdictFor } from "../plugins/registry";
import { askOwner } from "../tasks/loop";
import type { Tasks } from "../tasks/service";
import type { ScriptStore } from "./store";

const MAX_CALLS = 200;
const MAX_RUN_STEPS = 5000;
const MAX_ITEMS = 500;

class Failed extends Error {}

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const ANY = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Text for a value in a message or a comparison. */
export function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** A tool's answer: JSON when it is. */
export function answerOf(out: string): unknown {
  if (!/^\s*[[{]/.test(out)) return out;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const FILTERS: Record<string, (v: unknown) => unknown> = {
  join: (v) => (Array.isArray(v) ? v.map(textOf).join(", ") : v),
  lines: (v) => (Array.isArray(v) ? v.map(textOf).join("\n") : v),
  count: (v) =>
    Array.isArray(v) || typeof v === "string"
      ? v.length
      : v && typeof v === "object"
        ? Object.keys(v).length
        : 0,
  json: (v) => JSON.stringify(v ?? null),
};

export function lookup(vars: Record<string, unknown>, expr: string): unknown {
  const [path = "", ...filters] = expr.split("|").map((p) => p.trim());
  const [first = "", ...rest] = path.split(".");
  if (!Object.hasOwn(vars, first)) throw new Failed(`nothing is called ${first} yet`);
  let v = vars[first];
  for (const key of rest) {
    if (v === null || v === undefined) return null;
    if (key === "length" && (Array.isArray(v) || typeof v === "string")) v = v.length;
    else if (Array.isArray(v) && /^\d+$/.test(key)) v = v[Number(key)];
    else if (typeof v === "object" && Object.hasOwn(v, key))
      v = (v as Record<string, unknown>)[key];
    else v = null;
  }
  for (const f of filters) {
    const fn = FILTERS[f];
    if (!fn) throw new Failed(`there's no "| ${f}"; there's | join, | lines, | count and | json`);
    v = fn(v);
  }
  return v ?? null;
}

/** `{{path}}` alone is the value itself; inside text, its text. A secret's placeholder stays. */
export function fill(v: unknown, vars: Record<string, unknown>): unknown {
  if (typeof v === "string") {
    const whole = WHOLE.exec(v);
    if (whole?.[1] && !whole[1].startsWith("secret:")) return lookup(vars, whole[1]);
    return v.replace(ANY, (all, expr: string) =>
      expr.startsWith("secret:") ? all : textOf(lookup(vars, expr)),
    );
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

function numberOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN;
  if (Number.isNaN(n)) throw new Failed(`${JSON.stringify(v)} isn't a number`);
  return n;
}

const same = (a: unknown, b: unknown) =>
  typeof a === "number" || typeof b === "number"
    ? textOf(a).trim() === textOf(b).trim() || Number(a) === Number(b)
    : textOf(a) === textOf(b);

const empty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && Object.keys(v as object).length === 0);

export function holds(c: ScriptCondition, vars: Record<string, unknown>): boolean {
  if ("all" in c) return c.all.every((x) => holds(x, vars));
  if ("any" in c) return c.any.some((x) => holds(x, vars));
  if ("not" in c) return !holds(c.not, vars);
  const a = fill(c.value, vars);
  const b = fill(c.to, vars);
  switch (c.is) {
    case "equals":
      return same(a, b);
    case "not_equals":
      return !same(a, b);
    case "above":
      return numberOf(a) > numberOf(b);
    case "below":
      return numberOf(a) < numberOf(b);
    case "contains":
    case "not_contains": {
      const has = Array.isArray(a)
        ? a.some((x) => same(x, b))
        : textOf(a).toLowerCase().includes(textOf(b).toLowerCase());
      return c.is === "contains" ? has : !has;
    }
    case "matches":
      try {
        return new RegExp(textOf(b), "i").test(textOf(a));
      } catch {
        throw new Failed(`${JSON.stringify(b)} isn't a regular expression`);
      }
    case "empty":
      return empty(a);
    case "not_empty":
      return !empty(a);
  }
}

/** The tools a script of `botId`'s may call: what its tasks are offered, apart from the core's own. */
export function scriptTools(tasks: Tasks, botId: string): PluginTool[] {
  const { d } = tasks;
  const bot = d.bots.get(botId) ?? d.bots.hatbot();
  const others = d.bots.list().filter((b) => b.id !== bot.id);
  return d.plugins
    .tools(bot.plugins, d.bots.leftToOthers(bot))
    .filter(
      (t) =>
        t.access !== "own" &&
        !t.name.startsWith("script_") &&
        offered(t, { place: "task", bot, others, incognito: false }),
    );
}

export async function runScript(
  tasks: Tasks,
  store: ScriptStore,
  task: Task,
  job: ScriptJob,
  signal: AbortSignal,
): Promise<{ summary: string; found: Record<string, unknown> }> {
  const { d } = tasks;
  const id = task.id;
  const script = store.get(job.script);
  if (!script) throw new JobStop("failed", "Its script was deleted.");
  if (!script.enabled) throw new JobStop("failed", `The script ${script.name} is switched off.`);
  if (script.writes.length && !script.approved)
    throw new JobStop(
      "failed",
      `Not run: ${script.name} changes things, and you haven't approved it as it is.`,
    );
  store.ran(script.id);
  const bot = d.bots.get(script.botId) ?? d.bots.hatbot();
  const numbers = new Map<ScriptStep, number>();
  let n = 0;
  for (const [s] of stepsIn(script.steps)) numbers.set(s, ++n);

  const vars: Record<string, unknown> = {
    input: { ...Object.fromEntries(script.inputs.map((i) => [i.name, null])), ...job.input },
    now: new Date(tasks.clock()).toISOString(),
  };
  let tainted = task.tainted ? task.taintedBy || "What started it" : null;
  const taint = (by: string) => {
    if (tainted) return;
    tainted = by;
    tasks.taint(id, by);
  };
  let calls = 0;
  let ran = 0;
  let stopped: string | null = null;

  const cc: CallContext = {
    task: { id, tainted: Boolean(tainted) },
    signal,
    bot,
    tainted: () => tainted,
    taint,
  };

  const change = async (t: PluginTool, input: unknown, at: string) => {
    if (!script.writes.includes(t.name))
      throw new Failed(
        `${at}: ${t.name} changes things, and you didn't approve that in this script`,
      );
    const what = describeCall(t, input);
    const verdict = verdictFor(t, input, cc, Boolean(tainted), d.settings.get().safety);
    if (verdict.action === "block") throw new Failed(`${at}: refused: ${verdict.why}`);
    if (verdict.action === "allow") return;
    if (scopable(verdict) || levelOf(d.settings.get(), verdict) === "allow") {
      tasks.addStep(id, {
        kind: "approval",
        name: "Not asking: you approved the script",
        detail: what,
        url: null,
      });
      return;
    }
    const answer = await askOwner(
      tasks,
      id,
      {
        botId: bot.id,
        kind: verdict.kind ?? "other",
        summary: what,
        reason: verdict.why,
        sources: tainted ? [tainted] : [],
        call: { tool: t.name, input, target: t.target?.(input as never) ?? null },
      },
      null,
      (wait) => {
        tasks.setStatus(id, "waiting_approval");
        return wait().finally(() => tasks.setStatus(id, "running"));
      },
      signal,
    );
    if (answer.outcome !== "approved") throw new Failed(`${at}: you said no to ${what}`);
  };

  const call = async (s: Extract<ScriptStep, { call: string }>, at: string) => {
    if (++calls > MAX_CALLS) throw new Failed(`it made more than ${MAX_CALLS} tool calls`);
    const t = scriptTools(tasks, bot.id).find((x) => x.name === s.call);
    if (!t)
      throw new Failed(
        `${at}: ${bot.name} has no tool called ${s.call} now: its plugin is off, or not one ${bot.name} may use`,
      );
    const input = fill(s.input ?? {}, vars);
    if (t.access === "write") await change(t, input, at);
    tasks.addStep(id, { kind: "action", name: t.name, detail: describeCall(t, input), url: null });
    const r = await runPluginTool(t, input, cc, d.plugins.hideSecrets);
    if (r.untrusted) taint(describeCall(t, input));
    if (r.isError && !s.optional) throw new Failed(`${at}: ${t.name} failed: ${r.text}`);
    if (s.as) vars[s.as] = r.isError ? { error: r.text } : answerOf(r.text);
  };

  const step = async (s: ScriptStep) => {
    signal.throwIfAborted();
    if (++ran > MAX_RUN_STEPS) throw new Failed(`it ran more than ${MAX_RUN_STEPS} steps`);
    const at = `Step ${numbers.get(s)}`;
    try {
      if ("call" in s) return await call(s, at);
      if ("if" in s) return await list(holds(s.if, vars) ? s.do : (s.else ?? []));
      if ("each" in s) {
        const items = fill(s.each.includes("{{") ? s.each : `{{${s.each}}}`, vars);
        if (!Array.isArray(items)) throw new Failed(`${s.each} isn't a list`);
        if (items.length > MAX_ITEMS)
          throw new Failed(`${s.each} has ${items.length} items, more than ${MAX_ITEMS}`);
        for (const item of items) {
          vars[s.as] = item;
          await list(s.do);
          if (stopped !== null) return;
        }
        return;
      }
      if ("set" in s) {
        vars[s.set] = fill(s.to, vars);
        return;
      }
      if ("add" in s) {
        const now = vars[s.add] ?? [];
        if (!Array.isArray(now)) throw new Failed(`${s.add} isn't a list`);
        vars[s.add] = [...now, fill(s.value, vars)];
        return;
      }
      if ("notify" in s) {
        const message = textOf(fill(s.notify, vars));
        tasks.addStep(id, { kind: "action", name: "Told you", detail: message, url: null });
        const path = d.chats.finding({
          botId: bot.id,
          title: script.name,
          message,
          key: `script:${script.id}`,
          taintedBy: tainted && `What the script "${script.name}" read: ${tainted}`,
        });
        void d.notifier.send({
          title: (bot.id === HATBOT_ID ? script.name : `${bot.name} · ${script.name}`).slice(
            0,
            120,
          ),
          message,
          priority: 4,
          click: `${d.config.publicUrl}${path}`,
        });
        return;
      }
      if ("post" in s) {
        const text = textOf(fill(s.post, vars));
        tasks.addStep(id, { kind: "action", name: "Noted in the chat", detail: text, url: null });
        d.chats.note(bot.id, text, tainted && `What the script "${script.name}" read: ${tainted}`);
        return;
      }
      if ("task" in s) {
        const goal = textOf(fill(s.task, vars));
        const { now: _, ...found } = vars;
        const started = tasks.createBackgroundTask({
          title: s.title ?? script.name,
          goal,
          origin: task.origin,
          source: script.name,
          scheduleId: task.scheduleId ?? undefined,
          watcherId: task.watcherId ?? undefined,
          botId: bot.id,
          runKey: `script:${script.id}:task`,
          payload: `What the script "${script.name}" found:\n${JSON.stringify(found, null, 1).slice(0, 20_000)}`,
          trusted: !tainted,
          taintedBy: tainted,
        });
        tasks.addStep(id, {
          kind: "task",
          name: started ? (s.title ?? script.name) : "Not started: its last task still runs",
          detail: goal,
          url: started ? `/tasks/${started.id}` : null,
        });
        return;
      }
      stopped = textOf(fill(s.stop, vars));
      if (s.failed) throw new JobStop("failed", stopped);
    } catch (err) {
      if (err instanceof Failed && !err.message.startsWith("Step "))
        throw new Failed(`${at}: ${err.message}`);
      throw err;
    }
  };

  const list = async (steps: ScriptStep[]) => {
    for (const s of steps) {
      await step(s);
      if (stopped !== null) return;
    }
  };

  try {
    await list(script.steps);
  } catch (err) {
    if (err instanceof Failed) throw new JobStop("failed", `${err.message}.`);
    throw err;
  }
  const { now: _, ...found } = vars;
  return {
    summary: stopped ?? `Ran to the end, with ${calls} tool call${calls === 1 ? "" : "s"}.`,
    found,
  };
}
