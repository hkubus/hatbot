// T3 Code works in the owner's own projects with full access, so it commits, pushes and opens pull
// requests itself; Hatbot only hands it the request and reads its last message. Boxes go through
// box_t3 instead.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "../../db";
import { getSetting, setSetting } from "../../settings";
import { runStats, type T3Code, type T3Project } from "../../t3";
import { allow, ask, block, definePlugin, needsSetup, PluginError, ready, tool } from "../plugin";

export const T3_MODELS = { opus: "claude-opus-5-5", haiku: "claude-haiku-5-5" } as const;
const UNTIL = "t3:signed-in-until";
const SIGN_IN_MS = 10 * 60_000;

type Pending = { url: string; clientId: string; verifier: string; redirect: string; at: number };
/** Outside the plugin: saving its address restarts it between Connect and the way back. */
const pending = new Map<string, Pending>();

const Finish = z.object({ code: z.string().min(1).max(1000), state: z.string().min(1).max(200) });

async function why(res: Response) {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const said = body.error_description ?? body.error;
  return typeof said === "string" ? said : `it answered ${res.status}`;
}

export const t3Plugin = (d: {
  t3: T3Code;
  db: Db;
  publicUrl: string;
  saveToken: (token: string) => Promise<void>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) =>
  definePlugin({
    id: "t3",
    name: "T3 Code",
    description: "Code work done by T3 Code on your own computer, in your projects",
    env: [{ name: "T3_TOKEN", secret: true, hint: "Set when you connect below" }],
    config: z.object({
      url: z.string().max(300).default(""),
      model: z.enum(["opus", "haiku"]).default("opus"),
      minutes: z.number().int().min(5).max(240).default(60),
    }),
    start: ({ config, env }) => {
      const http = d.fetch ?? fetch;
      const url = config.url.replace(/\/+$/, "");
      const redirect = `${d.publicUrl}/settings/plugins/t3`;
      const actions = {
        connect: async () => {
          if (!url) throw new PluginError("Set T3 Code's address first.");
          const reg = await http(`${url}/oauth/mcp/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "Hatbot",
              redirect_uris: [redirect],
              grant_types: ["authorization_code"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          }).catch(() => {
            throw new PluginError(`T3 Code at ${url} didn't answer.`);
          });
          if (!reg.ok) throw new PluginError(`T3 Code wouldn't register Hatbot: ${await why(reg)}`);
          const { client_id: clientId } = (await reg.json()) as { client_id?: string };
          if (typeof clientId !== "string")
            throw new PluginError("T3 Code didn't register Hatbot.");
          const verifier = randomBytes(32).toString("base64url");
          const state = randomBytes(24).toString("base64url");
          const now = Date.now();
          for (const [k, p] of pending) if (now - p.at > SIGN_IN_MS) pending.delete(k);
          pending.set(state, { url, clientId, verifier, redirect, at: now });
          const go = new URL(`${url}/oauth/mcp/authorize`);
          for (const [k, v] of Object.entries({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirect,
            state,
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
          }))
            go.searchParams.set(k, v);
          return { url: go.href };
        },
        finish: async (args: unknown) => {
          const a = Finish.safeParse(args);
          const p = a.success && pending.get(a.data.state);
          if (!a.success || !p || Date.now() - p.at > SIGN_IN_MS)
            throw new PluginError("That sign-in is out of date: connect again.");
          pending.delete(a.data.state);
          const res = await http(`${p.url}/oauth/mcp/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: a.data.code,
              redirect_uri: p.redirect,
              client_id: p.clientId,
              code_verifier: p.verifier,
            }),
          });
          if (!res.ok) throw new PluginError(`T3 Code didn't sign Hatbot in: ${await why(res)}`);
          const t = (await res.json()) as { access_token?: string; expires_in?: number };
          if (typeof t.access_token !== "string")
            throw new PluginError("T3 Code didn't sign Hatbot in.");
          setSetting(d.db, UNTIL, String(Date.now() + (t.expires_in ?? 0) * 1000));
          await d.saveToken(t.access_token);
          return {};
        },
      };
      const until = Number(getSetting(d.db, UNTIL) ?? 0);
      const setup = (message: string) => ({ ...needsSetup(message), actions });
      if (!url) return setup("Set the address of your T3 Code, then connect it.");
      if (!env.T3_TOKEN) return setup("Connect it to your T3 Code below.");
      if (until && until < Date.now())
        return setup("T3 Code's sign-in ran out after 30 days: connect it again.");
      d.t3.configure({
        url,
        token: env.T3_TOKEN,
        model: T3_MODELS[config.model],
        minutes: config.minutes,
      });

      const find = async (name: string, signal: AbortSignal): Promise<T3Project> => {
        const all = await d.t3.projects(signal);
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
            const all = await d.t3.projects(call.signal);
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
            carry_on: z
              .boolean()
              .default(false)
              .describe("Carry on its last thread in this project"),
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
                  ...ask(
                    "It runs on your computer with full access, after reading outside content.",
                  ),
                  tainted: true,
                }
              : allow();
          },
          run: async ({ project, request, worktree, base, carry_on }, call) => {
            if (!call.task) throw new PluginError("T3 Code runs in a task.");
            const key = `task-${call.task.id}`;
            const p = await find(project, call.signal);
            const thread = carry_on ? d.t3.last(key, p.id) : null;
            if (carry_on && !thread)
              throw new PluginError(
                `T3 Code hasn't worked in ${p.title} in this task yet, so there's nothing to carry on.`,
              );
            const line = request.trim().split("\n")[0] ?? "";
            const work = () =>
              d.t3.run({
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
            d.t3.remember(key, p.id, r.threadId);
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
          "t3_code hands code work to T3 Code, which works on its own in one of the owner's T3 projects on their computer, with full access: it can commit, push and open the pull request itself when you ask it to. t3_projects lists the projects. Check its summary before you tell the owner it's done. A new box, or a big change to one, goes to box_t3. Quick edits and one-off scripts stay with code_run and box_edit.",
        test: async () => {
          const all = await d.t3.projects(AbortSignal.timeout(30_000));
          const left = until ? Math.max(0, Math.round((until - Date.now()) / 86_400_000)) : null;
          return `T3 Code works: ${all.length} project${all.length === 1 ? "" : "s"}${left === null ? "" : `; its sign-in has ${left} day${left === 1 ? "" : "s"} left`}.`;
        },
        stop: () => d.t3.configure(null),
      });
    },
  });
