// T3 Code works in the owner's own projects with full access, so it commits, pushes and opens pull
// requests itself; Hatbot only hands it the request and reads its last message. Boxes go through
// boxes_t3 instead.

import {
  allow,
  ask,
  block,
  definePlugin,
  needsSetup,
  PluginError,
  ready,
  tool,
} from "@hatbot/plugin-sdk";
import { oauthClient } from "@hatbot/plugin-sdk/oauth";
import { z } from "zod";
import { runStats, T3Code, type T3Project } from "./client";

export const T3_MODELS = { opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" } as const;
const UNTIL = "signed-in-until";

/** Gives the `t3` service, its client, while it's connected. */
export const t3Plugin = definePlugin({
  id: "t3",
  name: "T3 Code",
  description: "Code work done by T3 Code on your own computer, in your projects",
  env: [{ name: "T3_TOKEN", secret: true, hint: "Set when you connect below" }],
  config: z.object({
    url: z.string().max(300).default(""),
    model: z.enum(["opus", "haiku"]).default("opus"),
    minutes: z.number().int().min(5).max(240).default(60),
  }),
  provides: ["t3"],
  start: ({ config, env, publicUrl, fetch: http, store, saveSecrets }) => {
    const signIn = oauthClient("T3 Code", `${publicUrl}/settings/plugins/t3`);
    const url = config.url.replace(/\/+$/, "");
    const actions = {
      connect: async () => {
        if (!url) throw new PluginError("Set T3 Code's address first.");
        return signIn.connect(
          {
            register: `${url}/oauth/mcp/register`,
            authorize: `${url}/oauth/mcp/authorize`,
            token: `${url}/oauth/mcp/token`,
          },
          http,
        );
      },
      finish: async (args: unknown) => {
        const t = await signIn.finish(args, http);
        store.set(UNTIL, String(Date.now() + (t.expiresIn ?? 0) * 1000));
        await saveSecrets({ T3_TOKEN: t.token });
        return {};
      },
    };
    const until = Number(store.get(UNTIL) ?? 0);
    const setup = (message: string) => ({ ...needsSetup(message), actions });
    if (!url) return setup("Set the address of your T3 Code, then connect it.");
    if (!env.T3_TOKEN) return setup("Connect it to your T3 Code below.");
    if (until && until < Date.now())
      return setup("T3 Code's sign-in ran out after 30 days: connect it again.");
    const t3 = new T3Code();
    t3.configure({
      url,
      token: env.T3_TOKEN,
      model: T3_MODELS[config.model],
      minutes: config.minutes,
    });

    const find = async (name: string, signal: AbortSignal): Promise<T3Project> => {
      const all = await t3.projects(signal);
      const want = name.trim().toLowerCase();
      const found =
        all.find((p) => p.id === name) ?? all.find((p) => p.title.toLowerCase() === want);
      if (!found)
        throw new PluginError(
          `T3 Code has no project "${name}". It has: ${all.map((p) => p.title).join(", ") || "none"}.`,
        );
      return found;
    };

    const tools = [
      tool({
        name: "t3_projects",
        description: "List the projects in the owner's T3 Code: their names and folders.",
        access: "read",
        schema: z.object({}),
        run: async (_, call) => {
          const all = await t3.projects(call.signal);
          return all.length
            ? all.map((p) => `${p.title}: ${p.root}`).join("\n")
            : "T3 Code has no projects.";
        },
      }),
      tool({
        name: "t3_code",
        description: `Hand code work to T3 Code on the owner's computer: an agent works on its own in one of their T3 projects for up to ${config.minutes} minutes, with full access, reading, changing and running the code and its tests, and ends with a summary. By default it works in a new git worktree off base, on a branch of its own. Give it the whole request, including whether to commit, push or open a pull request: it sees nothing else. The owner can follow and steer it in T3 Code. carry_on: true sends the request to its last thread in that project in this task, after it ran out of time or to fix what you found.`,
        access: "write",
        label: "Handing it to T3 Code",
        schema: z.object({
          project: z.string().min(1).max(200).describe("The T3 project's name, from t3_projects"),
          request: z.string().min(1).max(20_000).describe("What to do, in full"),
          worktree: z
            .boolean()
            .default(true)
            .describe("Work in a new worktree; false works in the project's own checkout"),
          base: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^-\s]\S*$/, "A branch, tag or commit")
            .default("HEAD")
            .describe("What the new worktree starts from"),
          carry_on: z.boolean().default(false).describe("Carry on its last thread in this project"),
        }),
        // It reads code, issues and pages strangers wrote, and says what it likes about them.
        untrusted: true,
        describe: ({ project, request }) => {
          const line = request.trim().split("\n")[0] ?? "";
          return `T3 Code in ${project}: ${line.length > 100 ? `${line.slice(0, 99)}…` : line}`;
        },
        target: ({ project }) => project,
        policy: (_, call) => {
          if (!call.task)
            return block(
              "T3 Code runs in a task: start one with run_task and have it call t3_code.",
            );
          // Unlike a sandbox, it can do anything the owner can on their computer.
          return call.task.tainted
            ? {
                ...ask("It runs on your computer with full access, after reading outside content."),
                tainted: true,
              }
            : allow();
        },
        run: async ({ project, request, worktree, base, carry_on }, call) => {
          if (!call.task) throw new PluginError("T3 Code runs in a task.");
          const key = `task-${call.task.id}`;
          const p = await find(project, call.signal);
          const thread = carry_on ? t3.last(key, p.id) : null;
          if (carry_on && !thread)
            throw new PluginError(
              `T3 Code hasn't worked in ${p.title} in this task yet, so there's nothing to carry on.`,
            );
          const line = request.trim().split("\n")[0] ?? "";
          const work = () =>
            t3.run({
              project: p.id,
              base: worktree ? base : undefined,
              title: line.length > 60 ? `${line.slice(0, 59)}…` : line,
              prompt: request,
              thread,
              signal: call.signal,
              onActivity: call.progress,
            });
          // It can take an hour: the task's slot is free for others meanwhile.
          const r = await (call.away ? call.away(work) : work());
          t3.remember(key, p.id, r.threadId);
          return [
            r.ok ? r.text.trim() || "It said nothing." : r.text,
            `(${runStats(r)}; T3 Code thread ${r.threadId})`,
          ].join("\n\n");
        },
      }),
    ];
    return ready(tools, {
      actions,
      guidance:
        "t3_code hands code work to T3 Code, which works on its own in one of the owner's T3 projects on their computer, with full access: it can commit, push and open the pull request itself when you ask it to. t3_projects lists the projects. Check its summary before you tell the owner it's done. A new box, or a big change to one, goes to boxes_t3. Quick edits and one-off scripts stay with code_run and boxes_edit.",
      test: async () => {
        const all = await t3.projects(AbortSignal.timeout(30_000));
        const left = until ? Math.max(0, Math.round((until - Date.now()) / 86_400_000)) : null;
        return `T3 Code works: ${all.length} project${all.length === 1 ? "" : "s"}${left === null ? "" : `; its sign-in has ${left} day${left === 1 ? "" : "s"} left`}.`;
      },
      services: { t3 },
      stop: () => t3.configure(null),
    });
  },
});
