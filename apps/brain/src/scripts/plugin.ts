// Scripts: steps a bot saves once and the brain runs without the model, from the chat, a task, a
// schedule or a watcher. One that changes things is approved by you once, as written.
import {
  allow,
  askCareful,
  bodyOf,
  type CallContext,
  definePlugin,
  found,
  idParam,
  PluginError,
  type PluginTool,
  pluginRoutes,
  ready,
  type ScriptsService,
  tool,
  untrustedBlock,
} from "@hatbot/plugin-sdk";
import {
  type Bot,
  describeSteps,
  RunScript,
  SaveScript,
  type Script,
  type ScriptJob,
  type ScriptStep,
  stepsIn,
  type Task,
  UpdateScript,
} from "@hatbot/shared";
import { z } from "zod";
import type { Bots } from "../bots";
import type { EventBus } from "../events";
import type { Tasks } from "../tasks/service";
import { runScript, scriptTools } from "./run";
import { type ScriptFields, type ScriptStore, sameSteps } from "./store";

/** How long the chat waits for a run before it says it's still going. */
const CHAT_WAIT_MS = 60_000;
const FOUND_CHARS = 8000;

export type ScriptsDeps = { store: ScriptStore; tasks: Tasks; bots: Bots; events: EventBus };

const STEPS = `Each step is one object:
- {"call": tool, "input": {...}, "as": name, "optional": true}: calls one of your tools; its answer, parsed when it's JSON, goes in name. Without optional, a failure stops the script.
- {"if": condition, "do": [steps], "else": [steps]}
- {"each": "name.path", "as": "item", "do": [steps]}: for each item of a list.
- {"set": name, "to": value}, and {"add": name, "value": value}, which adds to the list in name.
- {"notify": text}: tells the owner, in this script's thread in your chat, with a notification. {"post": text}: a quiet note in your chat.
- {"task": prompt, "title": title}: starts a background task with the prompt and everything the script found so far, for what needs judgement.
- {"stop": text, "failed": true}: ends the run with text as its result; failed is optional.
A condition is {"value": v, "is": "equals"|"not_equals"|"above"|"below"|"contains"|"not_contains"|"matches"|"empty"|"not_empty", "to": v}, or {"all": [conditions]}, {"any": [conditions]}, {"not": condition}.
"{{name.path.0.field}}" on its own is that value; inside text it's its text. input.<name> is what the script was run with (a watcher's runs get input.value and input.previous) and now is the time. {{list | count}}, {{list | join}}, {{list | lines}} and {{x | json}} change a value.`;

const SaveInput = z.object({
  name: z
    .string()
    .describe(
      "Lowercase words joined with hyphens, like check-backups. Saving under a name you have changes that script",
    ),
  description: z.string().describe("What it does, in a sentence, for the owner"),
  inputs: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .optional()
    .describe(
      "What it's run with, read as {{input.<name>}}: what changes from one run to the next",
    ),
  steps: z.array(z.record(z.string(), z.unknown())).min(1).describe(STEPS),
  enabled: z.boolean().optional().describe("Off: it can't run until it's on again"),
});
type SaveInput = z.infer<typeof SaveInput>;

const ByName = z.object({ name: z.string() });

const problem = (err: z.ZodError) => {
  const issue = err.issues[0];
  const where = issue?.path.length ? ` (at ${issue.path.join(".")})` : "";
  return `${issue?.message ?? "Something in it isn't right"}${where}`;
};

/** A script's whole text, for its approval and the chat. */
export const scriptText = (s: Pick<Script, "name" | "description" | "steps">) =>
  `${s.name}: ${s.description}\n${describeSteps(s.steps).join("\n")}`;

export function scriptsPlugin(deps: () => ScriptsDeps) {
  /** Started from the chat, whose reply waits for it. */
  const waiting = new Set<number>();
  /** The chat stopped waiting for it, so its end is news. */
  const late = new Set<number>();
  const results = new Map<number, Record<string, unknown>>();

  const botOf = (call: CallContext) => call.bot ?? deps().bots.hatbot();

  /** The tools it changes things with; why it can't be saved, as a PluginError. */
  function check(steps: ScriptStep[], botId: string): string[] {
    const { tasks, bots } = deps();
    const tools = scriptTools(tasks, botId);
    const writes = new Set<string>();
    let n = 0;
    for (const [s] of stepsIn(steps)) {
      n++;
      if (!("call" in s)) continue;
      const t = tools.find((x) => x.name === s.call);
      if (!t)
        throw new PluginError(
          `Step ${n} calls ${s.call}, which isn't a tool ${bots.nameOf(botId)}'s scripts can call. They can call: ${tools.map((x) => x.name).join(", ")}.`,
        );
      if (!JSON.stringify(s.input ?? {}).includes("{{")) {
        const p = t.schema.safeParse(s.input ?? {});
        if (!p.success)
          throw new PluginError(
            `Step ${n}: ${s.call} doesn't take that input: ${problem(p.error)}.`,
          );
      }
      if (t.access === "write") writes.add(t.name);
    }
    return [...writes];
  }

  function fieldsOf(input: SaveInput, bot: Bot): ScriptFields & { writes: string[] } {
    const p = SaveScript.safeParse({ ...input, botId: bot.id });
    if (!p.success) throw new PluginError(`Not saved: ${problem(p.error)}.`);
    return { ...p.data, writes: check(p.data.steps, bot.id) };
  }

  /** Writes that would run without asking, which you haven't seen as they are. */
  function needsApproval(input: SaveInput, bot: Bot): string[] {
    let fields: ScriptFields;
    try {
      fields = fieldsOf(input, bot);
    } catch {
      return [];
    }
    if (!fields.writes.length) return [];
    const old = deps().store.byName(bot.id, fields.name);
    return old?.approved && sameSteps(old, fields) ? [] : fields.writes;
  }

  const service: ScriptsService = {
    get: (id) => deps().store.get(id),
    byName: (botId, name) => deps().store.byName(botId, name),
    start: (script, o) => start(script, o),
  };

  function start(
    script: Script,
    o: Parameters<ScriptsService["start"]>[1] & {
      message?: number;
      parent?: Task;
    },
  ): Task | null {
    const { tasks } = deps();
    const job: ScriptJob = { script: script.id, input: o.input };
    const taintedBy =
      o.taintedBy ??
      (script.tainted
        ? `Its script, which the chat wrote after reading: ${script.taintedBy ?? "untrusted content"}`
        : null);
    return tasks.createBackgroundTask({
      title: script.name,
      goal: script.description,
      origin: o.origin as Task["origin"],
      source: o.source,
      scheduleId: o.scheduleId,
      watcherId: o.watcherId,
      runKey: o.runKey,
      botId: script.botId,
      message: o.message,
      parent: o.parent,
      runner: "script",
      job,
      taintedBy,
    });
  }

  /** The run as the chat or a task hears it. */
  function ended(task: Task, call: CallContext): string {
    const what = results.get(task.id);
    results.delete(task.id);
    if (task.tainted) call.taint?.(`The script run, task #${task.id}`);
    const head = `${task.title} (task #${task.id}) ${task.status === "done" ? "ran" : task.status}: ${task.summary ?? ""}`;
    if (!what) return head;
    const text = JSON.stringify(what, null, 1);
    const shown = text.length > FOUND_CHARS ? `${text.slice(0, FOUND_CHARS)}…` : text;
    return `${head}\nWhat it found:\n${task.tainted ? untrustedBlock("script_values", shown) : shown}`;
  }

  const tools: PluginTool[] = [
    tool({
      name: "script_save",
      label: "Saving a script",
      description: `Save a script: steps the brain runs without a model, for what's done the same way every time, like a check the owner asks for often or a schedule's or watcher's work. It runs with script_run, or from a schedule or watcher. It can call your plugins' tools, not the core's (memory, tasks, threads). One that changes things asks the owner to approve it once, as written; then its changes run without asking, except money, accounts and doors. Test it with script_run after saving.\n\n${STEPS}`,
      schema: SaveInput,
      access: "write",
      places: ["chat", "task"],
      deferred: true,
      whole: true,
      describe: (input) =>
        `Save the script ${scriptText({ ...input, steps: input.steps as ScriptStep[] })}`,
      policy: (input, call) => {
        const writes = needsApproval(input, botOf(call));
        return writes.length
          ? askCareful(
              `It changes things with ${writes.join(", ")} each time it runs, without asking you.`,
            )
          : allow();
      },
      run: async (input, call) => {
        const bot = botOf(call);
        const fields = fieldsOf(input, bot);
        const old = deps().store.byName(bot.id, fields.name);
        const s = deps().store.save(fields, {
          id: old?.id,
          via: "chat",
          // Its policy asked you for whatever changes things.
          approved: fields.writes.length > 0,
          taintedBy: call.tainted?.() ?? null,
        });
        return `${old ? "Changed" : "Saved"} the script #${s.id} ${scriptText(s)}${s.writes.length ? `\nIt changes things with ${s.writes.join(", ")}, as the owner approved.` : ""}`;
      },
    }),
    tool({
      name: "script_list",
      label: "Looking at scripts",
      description: "Your scripts, with what each does and when it last ran.",
      schema: z.object({}),
      access: "read",
      places: ["chat", "task"],
      deferred: true,
      run: async (_, call) =>
        deps()
          .store.list(botOf(call).id)
          .map(
            (s) =>
              `${s.name}: ${s.description}${s.enabled ? "" : " (off)"}${s.inputs.length ? `; inputs ${s.inputs.map((i) => i.name).join(", ")}` : ""}${s.lastRunAt ? `; last ran ${s.lastRunAt.slice(0, 16).replace("T", " ")}` : ""}`,
          )
          .join("\n") || "No scripts yet.",
    }),
    tool({
      name: "script_read",
      label: "Reading a script",
      description: "A script's steps, as JSON and in words.",
      schema: ByName,
      access: "read",
      places: ["chat", "task"],
      deferred: true,
      whole: true,
      run: async ({ name }, call) => {
        const s = deps().store.byName(botOf(call).id, name);
        if (!s) throw new PluginError(`No script called ${name}.`);
        if (s.tainted)
          call.taint?.(`The script ${s.name}, written after reading untrusted content`);
        return `${scriptText(s)}\n\n${JSON.stringify({ inputs: s.inputs, steps: s.steps })}`;
      },
    }),
    tool({
      name: "script_run",
      label: "Running a script",
      description:
        "Run one of your scripts now, without a model, and get back its result and what it found. Use it whenever the owner asks for what a script does.",
      schema: z.object({
        name: z.string(),
        input: z.record(z.string(), z.unknown()).optional().describe("Its inputs, by name"),
      }),
      access: "own",
      places: ["chat", "task"],
      deferred: true,
      whole: true,
      describe: ({ name }) => name,
      run: async ({ name, input }, call) => {
        const { store, tasks } = deps();
        const bot = botOf(call);
        const s = store.byName(bot.id, name);
        if (!s) {
          const names = store.list(bot.id).map((x) => x.name);
          throw new PluginError(
            `No script called ${name}.${names.length ? ` Yours: ${names.join(", ")}.` : ""}`,
          );
        }
        if (!s.enabled) throw new PluginError(`The script ${s.name} is switched off.`);
        const parent = call.task ? (tasks.get(call.task.id) ?? undefined) : undefined;
        const task = start(s, {
          origin: parent?.origin ?? "chat",
          source: s.name,
          input: input ?? {},
          message: parent ? undefined : call.messageId,
          parent,
          taintedBy: call.tainted?.() ?? null,
        });
        if (!task) throw new PluginError("Not run: it couldn't start.");
        if (call.waitForTask) return ended(await call.waitForTask(task.id), call);
        waiting.add(task.id);
        const timeout = AbortSignal.any([call.signal, AbortSignal.timeout(CHAT_WAIT_MS)]);
        try {
          return ended(await tasks.waitFor(task.id, timeout), call);
        } catch (err) {
          if (call.signal.aborted) throw err;
          late.add(task.id);
          return `${s.name} is still running as task #${task.id}; you'll hear when it ends.`;
        } finally {
          waiting.delete(task.id);
        }
      },
    }),
    tool({
      name: "script_delete",
      label: "Deleting a script",
      description: "Delete one of your scripts. Its runs stay in the Tasks list.",
      schema: ByName,
      access: "write",
      places: ["chat", "task"],
      deferred: true,
      describe: ({ name }) => `Delete the script ${name}`,
      run: async ({ name }, call) => {
        const { store } = deps();
        const s = store.byName(botOf(call).id, name);
        if (!s) throw new PluginError(`No script called ${name}.`);
        store.delete(s.id);
        return `Deleted the script ${name}.`;
      },
    }),
  ];

  const owned = (body: z.output<typeof SaveScript>): ScriptFields => {
    if (!deps().bots.active(body.botId)) throw new PluginError("No such bot.");
    return { ...body, writes: check(body.steps, body.botId) };
  };

  const routes = pluginRoutes()
    .get("/scripts", (c) => c.json(deps().store.list()))
    .post("/scripts", async (c) => {
      const fields = owned(await bodyOf(c, SaveScript));
      return c.json(
        deps().store.save(fields, { via: "owner", approved: true, taintedBy: null }),
        201,
      );
    })
    .get("/scripts/:id", (c) => found(c, deps().store.get(idParam(c))))
    .patch("/scripts/:id", async (c) => {
      const { store } = deps();
      const old = store.get(idParam(c));
      if (!old) return c.json({ error: "That's gone." }, 404);
      const patch = await bodyOf(c, UpdateScript);
      // Only switching it on or off leaves who wrote it, and whether you approved it, as it was.
      if (Object.keys(patch).length === 1 && patch.enabled !== undefined)
        return c.json(store.setEnabled(old.id, patch.enabled));
      const fields = owned({ ...old, ...patch });
      return c.json(
        store.save(fields, { id: old.id, via: "owner", approved: true, taintedBy: null }),
      );
    })
    .delete("/scripts/:id", (c) =>
      deps().store.delete(idParam(c))
        ? c.json({ ok: true })
        : c.json({ error: "That's gone." }, 404),
    )
    .post("/scripts/:id/run", async (c) => {
      const s = deps().store.get(idParam(c));
      if (!s) return c.json({ error: "That's gone." }, 404);
      const { input } = await bodyOf(c, RunScript);
      const task = start(s, { origin: "chat", source: s.name, input, runKey: `script:${s.id}` });
      return task ? c.json(task, 201) : c.json({ error: "Its last run is still going." }, 409);
    });

  return definePlugin({
    id: "scripts",
    name: "Scripts",
    description: "",
    internal: true,
    config: z.object({}),
    provides: ["scripts"],
    routes: ["/scripts"],
    start: () => {
      const unlisten = deps().events.on((e) => {
        if (e.type === "bot.deleted") deps().store.moveFrom(e.id);
      });
      return ready(tools, {
        services: { scripts: service },
        routes,
        jobs: {
          script: {
            unsteerable: () =>
              "A script runs its steps without a model, so it can't be steered. Cancel it, or change the script.",
            run: async (job) => {
              const r = await runScript(
                deps().tasks,
                deps().store,
                job.task,
                job.input as ScriptJob,
                job.signal,
              );
              if (waiting.has(job.task.id) || job.task.parentId) results.set(job.task.id, r.found);
              // A run tells you with its notify steps, and a failure always does.
              const notify = late.delete(job.task.id);
              return { summary: r.summary, notify };
            },
          },
        },
        prompt: {
          chat: `- Scripts are steps you save once that run without a model: from the chat (script_run), a schedule or a watcher. Their tools load when you need them: find them with tool_search_tool_regex ("script_"). When the owner asks for something one of your scripts does, run it rather than doing it by hand; when they ask for the same thing again and again, offer to save it as one.`,
          task: `- A script (script_run) does its fixed steps without a model: use one of yours when it does what this task needs.`,
        },
        stop: unlisten,
      });
    },
  });
}
