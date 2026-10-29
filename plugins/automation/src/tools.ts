import {
  askOwner,
  BOT_GONE,
  type CallContext,
  clip,
  type Place,
  type PluginTool,
  tool,
} from "@hatbot/plugin-sdk";
import {
  type Bot,
  describeCondition,
  describeCron,
  HATBOT_ID,
  MAX_WATCH_MINUTES,
  minWatchMinutes,
  type Schedule,
  type Watcher,
  type WatchSource,
} from "@hatbot/shared";
import { z } from "zod";
import type { Deps } from "./deps";
import type { Schedules } from "./schedules";
import type { Triggers } from "./triggers";
import { conditionOf, describeLook, WatchError, type Watchers, watcherLine } from "./watch/service";

type Parts = { schedules: Schedules; triggers: Triggers; watchers: Watchers } & Pick<
  Deps,
  "bots" | "settings"
>;

const CHAT: Place[] = ["chat"];
type Change = { name: string; input: unknown; what: string };

const local = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–";
const cut = (s: string) => clip(s, 300);

const scheduleLine = (s: Schedule) =>
  `#${s.id} "${s.name}": ${s.cron ? `${describeCron(s.cron)} (cron ${s.cron})` : `once, ${local(s.runAt)}`}; ${s.enabled ? `next run ${local(s.nextRunAt)}` : "off"}${s.lastRunAt ? `; last ran ${local(s.lastRunAt)}${s.lastTaskId ? ` (task #${s.lastTaskId})` : ""}` : ""}\n  Does: ${s.prompt}`;

/** All of the change, in words for its approval, since it all goes ahead once approved. */
function changing(what: string, changes: string[]): string {
  return changes.length === 1 && changes[0] === "switch it off"
    ? `Switch off the ${what}`
    : `Change the ${what}: ${changes.join("; ")}`;
}

const watchFields = {
  render: z
    .boolean()
    .optional()
    .describe(
      'A page: load it in a headless browser on the desktop and run its scripts first, for a page that fills in with JavaScript (empty or "Loading…" without). Slower: such a watcher looks every 15 minutes at most. Sites with bot protection block it too',
    ),
  selector: z
    .string()
    .optional()
    .describe(
      'A page: the text of the elements this CSS selector matches, e.g. ".price" or "#stock"',
    ),
  path: z
    .string()
    .optional()
    .describe(
      'JSON (an API, or a tool that answers in JSON): the value at this path, e.g. "items.0.price"',
    ),
  pattern: z
    .string()
    .optional()
    .describe(
      'A regular expression over the text (case-insensitive): its first group is the value, e.g. "Price:\\s*([\\d.,]+)"',
    ),
  when: z
    .enum(["changed", "contains", "missing", "below", "above"])
    .optional()
    .describe(
      'When a new value counts: "changed" (any change; the default), "contains"/"missing" the text, or a number "below"/"above" the value. Only a move into it counts, not every check while it holds',
    ),
  text: z.string().optional().describe('For "contains" and "missing"'),
  value: z.number().optional().describe('For "below" and "above"'),
  every_minutes: z
    .number()
    .int()
    .positive()
    .max(MAX_WATCH_MINUTES)
    .optional()
    .describe(
      "How often to look, at least 5 (15 with render) and at most 10080 (a week); 60 if left out",
    ),
  once: z.boolean().optional().describe("Switch off after the first time it counts"),
  prompt: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "What to do when it counts, as a background task that's told the old and new value and can't see this conversation. Leave out to just tell the owner",
    ),
};

const scheduleWhen = {
  cron: z
    .string()
    .optional()
    .describe(
      'Repeating: five-field cron (minute hour day-of-month month day-of-week) in the owner\'s local time, e.g. "0 8 * * *" for every day at 08:00, "30 7 * * 1-5" for weekdays at 07:30. At most every 5 minutes',
    ),
  at: z.string().optional().describe('Once: local date and time, e.g. "2026-10-11T08:00"'),
};

const CreateSchedule = z.object({
  name: z.string().min(1).max(80).describe('Short name, e.g. "Framework 16 stock check"'),
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe("What each run does and when it should tell the owner, with every detail it needs"),
  ...scheduleWhen,
});
const UpdateSchedule = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(80).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
  ...scheduleWhen,
});
const ById = z.object({ id: z.number().int() });
const CreateWatch = z.object({
  name: z.string().min(1).max(80).describe('Short name, e.g. "Framework 16 price"'),
  url: z.string().optional().describe("A page or JSON API to fetch"),
  tool: z
    .string()
    .optional()
    .describe("Or a plugin's read tool to call, e.g. forgejo_issue or github_ci"),
  tool_input: z.record(z.string(), z.unknown()).optional().describe("The tool's input"),
  ...watchFields,
});
const UpdateWatch = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  ...watchFields,
});
const UpdateTrigger = z.object({
  id: z.number().int(),
  name: z.string().min(1).max(80).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
  confirmChecks: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe(
      "Uptime Kuma only: wait for this many more of the monitor's checks before acting on a down alert, so a blip that recovers starts nothing. 0 acts at once.",
    ),
});

export function automationTools(p: Parts): PluginTool[] {
  const { schedules, triggers, watchers, bots } = p;
  const untrustedAsks = () => p.settings.get().safety.untrusted;
  /** The bot was deleted while it wrote this reply: what it makes now would run as nobody's. */
  const gone = (call: CallContext) => Boolean(call.bot && !bots.active(call.bot.id));
  const whose = (botId: string, bot?: Bot) =>
    botId !== (bot?.id ?? HATBOT_ID) ? `\n  Runs as: ${bots.nameOf(botId)}` : "";

  /**
   * After reading untrusted content, the review checks deleting or switching off a schedule, watcher
   * or trigger: injected text mustn't quietly stop what looks after the homelab.
   */
  const asked = async (call: CallContext, change: Change) =>
    call.tainted?.() && untrustedAsks() ? askOwner(call, change, "untrusted") : "";

  /** A watcher for the chat: what it saw, from an untrusted source, is quoted and taints it. */
  function seenLine(call: CallContext, w: Watcher): string {
    const untrusted = watchers.sawUntrusted(w);
    if (untrusted && w.lastValue !== null) call.taint?.(`What the watcher "${w.name}" saw`);
    return watcherLine(w, untrusted);
  }

  /** Switching a trigger off, or changing how many failed checks it waits for, asks as above. */
  function stoppingTrigger(
    call: CallContext,
    id: number,
    patch: { enabled?: boolean; confirmChecks?: number },
  ): Promise<string> {
    const t = triggers.get(id);
    const off = t?.enabled && patch.enabled === false;
    const checks =
      t && patch.confirmChecks !== undefined && patch.confirmChecks !== t.confirmChecks;
    if (!t || (!off && !checks)) return Promise.resolve("");
    const n = patch.confirmChecks ?? 0;
    const what = [
      ...(off ? ["switch it off"] : []),
      ...(checks
        ? [n ? `wait for ${n} more failed check${n > 1 ? "s" : ""}` : "act on a down alert at once"]
        : []),
    ].join(", and ");
    return asked(call, {
      name: "automation_trigger_update",
      input: { id, ...patch },
      what: `Change the trigger #${id} "${t.name}": ${what}`,
    });
  }

  const own = { access: "own" as const, places: CHAT, deferred: true, whole: true };
  const look = {
    access: "read" as const,
    places: CHAT,
    deferred: true,
    whole: true,
    incognito: true,
  };

  return [
    tool({
      ...own,
      name: "automation_schedule_create",
      label: "Creating a schedule",
      description:
        "Schedule a background task that runs on its own, repeating (cron) or once (at). Each run gets your memory and tools, can use the desktop, and reports back in this thread, with a notification when there's something to tell. Write `prompt` as complete instructions for that future run: it can't see this conversation. If the owner's timing is vague, ask before creating it. The owner sees it in Schedules, where they can change or turn it off.",
      schema: CreateSchedule,
      run: async ({ name, prompt, cron, at }, call) => {
        if (gone(call)) return BOT_GONE;
        if (Boolean(cron) === Boolean(at)) return "Give either cron or at.";
        const s = schedules.create(
          { name, prompt, cron, at, botId: call.bot?.id ?? HATBOT_ID },
          "chat",
          call.tainted?.() ?? null,
        );
        call.scheduleCard?.(s);
        return `Created schedule ${scheduleLine(s)}`;
      },
    }),
    tool({
      ...look,
      name: "automation_schedule_list",
      label: "Looking at schedules",
      description: "List every schedule with its timing, next run and what it does.",
      schema: z.object({}),
      run: async (_, call) =>
        schedules
          .list()
          .map((s) => scheduleLine(s) + whose(s.botId, call.bot))
          .join("\n") || "No schedules.",
    }),
    tool({
      ...own,
      name: "automation_schedule_update",
      label: "Changing a schedule",
      description:
        "Change a schedule: its name, what it does, its timing, or turn it on or off. Only the fields you give change.",
      schema: UpdateSchedule,
      run: async ({ id, ...patch }, call) => {
        if (patch.cron && patch.at) return "Give either cron or at, not both.";
        const current = schedules.get(id);
        // On, it looks after something: after reading untrusted content, anything but switching it
        // on asks, since a new time or prompt can silence it as surely as switching it off. A new
        // name always does: it's what a later approval to delete it would show.
        const renamed =
          current && patch.name !== undefined && patch.name !== current.name
            ? [`rename it "${patch.name}"`]
            : [];
        const changes = current?.enabled
          ? [
              ...(patch.enabled === false ? ["switch it off"] : []),
              ...renamed,
              ...(patch.prompt !== undefined && patch.prompt !== current.prompt
                ? [`make it do: ${cut(patch.prompt)}`]
                : []),
              ...(patch.cron !== undefined && patch.cron !== current.cron
                ? [`run it ${describeCron(patch.cron).toLowerCase()}`]
                : []),
              ...(patch.at !== undefined ? [`run it once at ${patch.at}`] : []),
            ]
          : renamed;
        const note =
          current && changes.length
            ? await asked(call, {
                name: "automation_schedule_update",
                input: { id, ...patch },
                what: changing(`schedule #${id} "${current.name}"`, changes),
              })
            : "";
        const s = schedules.update(id, patch, {
          via: "chat",
          taintedBy: call.tainted?.() ?? null,
        });
        return s ? `Updated schedule ${scheduleLine(s)}${note}` : `No schedule #${id}.`;
      },
    }),
    tool({
      ...own,
      name: "automation_schedule_delete",
      label: "Deleting a schedule",
      description: "Delete a schedule. Its past runs stay in the Tasks list.",
      schema: ById,
      run: async ({ id }, call) => {
        const s = schedules.get(id);
        const note = s
          ? await asked(call, {
              name: "automation_schedule_delete",
              input: { id },
              what: `Delete the schedule #${id} "${s.name}"`,
            })
          : "";
        return schedules.delete(id) ? `Deleted schedule #${id}.${note}` : `No schedule #${id}.`;
      },
    }),
    tool({
      ...own,
      name: "automation_watch_create",
      label: "Setting up a watcher",
      description:
        "Watch a web page or a plugin's read tool and act only when its value changes the way the owner wants: back in stock, a price below a number, a PR merged, a new release. It's checked on a timer without a model, so it costs nothing until something happens; prefer it to a schedule for \"tell me when…\". Pages are fetched from the desktop as plain HTML without running their scripts; set render for a page that fills in with JavaScript. Neither gets past bot protection (a challenge page, a captcha). Pick one value out with selector, path or pattern: a whole page changes too often. It looks once before it's made and tells you what it saw, or why it couldn't, so you can fix the selector or pattern.",
      schema: CreateWatch,
      run: async (input, call) => {
        if (gone(call)) return BOT_GONE;
        if (Boolean(input.url) === Boolean(input.tool)) return "Give either url or tool.";
        const condition = conditionOf(input);
        if (typeof condition === "string") return condition;
        const prompt = input.prompt?.trim() ?? "";
        const source: WatchSource = {
          kind: input.url ? "page" : "tool",
          ...(input.url
            ? { url: input.url, ...(input.render ? { render: true } : {}) }
            : { tool: input.tool, input: input.tool_input ?? {} }),
          ...(input.selector ? { selector: input.selector } : {}),
          ...(input.path ? { path: input.path } : {}),
          ...(input.pattern ? { pattern: input.pattern } : {}),
        };
        try {
          const w = await watchers.create(
            {
              name: input.name,
              source,
              condition,
              prompt,
              everyMinutes: Math.max(minWatchMinutes(source), input.every_minutes ?? 60),
              once: input.once ?? false,
              enabled: true,
              botId: call.bot?.id ?? HATBOT_ID,
            },
            "chat",
            call.tainted?.() ?? null,
          );
          return `Created watcher ${seenLine(call, w)}`;
        } catch (err) {
          if (err instanceof WatchError) return `Not created: ${err.message}`;
          throw err;
        }
      },
    }),
    tool({
      ...look,
      name: "automation_watch_list",
      label: "Looking at watchers",
      description: "List every watcher with what it looks at, what it saw last, and what it does.",
      schema: z.object({}),
      run: async (_, call) =>
        watchers
          .list()
          .map((w) => seenLine(call, w) + whose(w.botId, call.bot))
          .join("\n") || "No watchers.",
    }),
    tool({
      ...own,
      name: "automation_watch_update",
      label: "Changing a watcher",
      description:
        "Change a watcher: what counts, how often it looks, whether it runs the page's scripts, what it does, its name, or turn it on or off. Only the fields you give change.",
      schema: UpdateWatch,
      run: async ({ id, ...input }, call) => {
        const w = watchers.get(id);
        if (!w) return `No watcher #${id}.`;
        const condition = input.when ? conditionOf(input) : undefined;
        if (typeof condition === "string") return condition;
        if (input.render !== undefined && w.source.kind !== "page")
          return "Only a page has scripts to run; this watcher calls a tool.";
        const picks = ["selector", "path", "pattern"] as const;
        const source: WatchSource | undefined =
          picks.some((k) => input[k] !== undefined) || input.render !== undefined
            ? {
                ...w.source,
                // An empty string takes that pick away.
                ...Object.fromEntries(
                  picks
                    .filter((k) => input[k] !== undefined)
                    .map((k) => [k, input[k] || undefined]),
                ),
                ...(input.render !== undefined ? { render: input.render || undefined } : {}),
              }
            : undefined;
        // Running the page's scripts looks less often, so a shorter time is raised to that.
        const min = minWatchMinutes(source ?? w.source);
        const every = input.every_minutes ?? (w.everyMinutes < min ? min : undefined);
        const renamed =
          input.name !== undefined && input.name !== w.name ? [`rename it "${input.name}"`] : [];
        const changes = w.enabled
          ? [
              ...(input.enabled === false ? ["switch it off"] : []),
              ...renamed,
              ...(input.prompt !== undefined && input.prompt.trim() !== w.prompt
                ? [
                    input.prompt.trim()
                      ? `make it do: ${cut(input.prompt.trim())}`
                      : "make it only tell the owner",
                  ]
                : []),
              ...(condition ? [`count when it ${describeCondition(condition).toLowerCase()}`] : []),
              ...(source ? [`look at ${describeLook(source)}`] : []),
              ...(input.every_minutes !== undefined && input.every_minutes !== w.everyMinutes
                ? [`look every ${input.every_minutes} min`]
                : []),
              ...(input.once !== undefined && input.once !== w.once
                ? [input.once ? "count only once" : "keep counting"]
                : []),
            ]
          : renamed;
        const note = changes.length
          ? await asked(call, {
              name: "automation_watch_update",
              input: { id, ...input },
              what: changing(`watcher #${id} "${w.name}"`, changes),
            })
          : "";
        try {
          const updated = await watchers.update(
            id,
            {
              name: input.name,
              enabled: input.enabled,
              condition,
              prompt: input.prompt?.trim(),
              everyMinutes: every === undefined ? undefined : Math.max(min, every),
              once: input.once,
              source,
            },
            { via: "chat", taintedBy: call.tainted?.() ?? null },
          );
          return updated
            ? `Updated watcher ${seenLine(call, updated)}${note}`
            : `No watcher #${id}.`;
        } catch (err) {
          if (err instanceof WatchError) return `Not changed: ${err.message}`;
          throw err;
        }
      },
    }),
    tool({
      ...own,
      name: "automation_watch_delete",
      label: "Deleting a watcher",
      description: "Delete a watcher. The tasks it started stay in the Tasks list.",
      schema: ById,
      run: async ({ id }, call) => {
        const w = watchers.get(id);
        const note = w
          ? await asked(call, {
              name: "automation_watch_delete",
              input: { id },
              what: `Delete the watcher #${id} "${w.name}"`,
            })
          : "";
        return watchers.delete(id) ? `Deleted watcher #${id}.${note}` : `No watcher #${id}.`;
      },
    }),
    tool({
      ...look,
      name: "automation_trigger_list",
      label: "Looking at triggers",
      description:
        "List the webhooks and Uptime Kuma alert hooks that start background tasks, with what each run does. The owner creates them in Automations.",
      schema: z.object({}),
      run: async (_, call) =>
        triggers
          .list()
          .map(
            (t) =>
              `#${t.id} "${t.name}" (${t.kind === "kuma" ? "Uptime Kuma" : "webhook"}${t.trusted ? ", trusted" : ""}${t.enabled ? "" : ", off"}${t.confirmChecks ? `, waits for ${t.confirmChecks} more failed check${t.confirmChecks > 1 ? "s" : ""}` : ""})${t.lastFiredAt ? `; last event ${local(t.lastFiredAt)}` : ""}\n  Does: ${t.prompt}${whose(t.botId, call.bot)}`,
          )
          .join("\n") || "No triggers.",
    }),
    tool({
      ...own,
      name: "automation_trigger_update",
      label: "Changing a trigger",
      description:
        "Change what a trigger's runs do, rename it, turn it on or off, or how many more failed checks an Uptime Kuma alert waits for. Only the fields you give change.",
      schema: UpdateTrigger,
      run: async ({ id, ...patch }, call) => {
        const current = triggers.get(id);
        // A trigger's runs trust its instructions, so the review checks a rewrite after untrusted content.
        const rewrite =
          current && patch.prompt !== undefined && patch.prompt !== current.prompt
            ? await asked(call, {
                name: "automation_trigger_update",
                input: { id, ...patch },
                what: `Change what the trigger #${id} "${current.name}" does: ${cut(patch.prompt)}`,
              })
            : "";
        const note = rewrite + (await stoppingTrigger(call, id, patch));
        const t = triggers.update(id, patch);
        return t ? `Updated trigger #${t.id} "${t.name}".${note}` : `No trigger #${id}.`;
      },
    }),
  ];
}
