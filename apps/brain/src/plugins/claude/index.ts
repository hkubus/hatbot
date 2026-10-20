// Claude Code: a task hands code work to Claude Code (`claude -p`), which runs on its own in a folder of
// the desktop's sandbox shell, on the owner's Claude subscription (src/claude-code.ts). It leaves its
// changes in the folder; the task checks them and pushes them with a forge's tools. Boxes it makes go
// through box_claude instead.
import { z } from "zod";
import { type ClaudeCode, runStats } from "../../claude-code";
import { type DesktopAgent, DesktopError } from "../../desktop/client";
import { allow, block, definePlugin, needsSetup, PluginError, ready, tool } from "../plugin";

const TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];

const SYSTEM =
  "You run in a sandbox: a throwaway Linux user with no secrets. Leave your changes in the working tree; don't commit or push, since whoever asked checks them first. Run the tests if there are any. End with a short summary of what you changed and what's left.";

/** A shell word, quoted. */
const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** A folder in the sandbox's home, by a path relative to it. */
const Folder = z
  .string()
  .min(1)
  .max(300)
  .transform((p) => p.replace(/^(\.\/)+/, "").replace(/\/+$/, "") || ".")
  .refine(
    (p) => !p.startsWith("/") && !p.startsWith("~") && !p.split("/").includes(".."),
    "A folder in the sandbox's home, by a path relative to it, without ..",
  );

export const claudePlugin = (d: { claude: ClaudeCode; desktop: DesktopAgent }) =>
  definePlugin({
    id: "claude",
    name: "Claude Code",
    description:
      "Code work done by Claude Code in the desktop's sandbox, on your Claude subscription",
    env: [
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        secret: true,
        hint: "What claude setup-token prints",
      },
    ],
    config: z.object({
      model: z.enum(["opus", "sonnet", "haiku"]).default("opus"),
      minutes: z.number().int().min(5).max(120).default(30),
    }),
    start: ({ config, env }) => {
      if (!d.desktop.configured)
        return needsSetup("The desktop isn't set up yet; Claude Code runs in its sandbox.");
      const token = env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token)
        return needsSetup(
          "Make a token with `claude setup-token` on a computer signed in to your Claude account and set it here.",
        );
      d.claude.configure({ token, model: config.model, minutes: config.minutes });

      const tools = [
        tool({
          name: "claude_code",
          description: `Hand code work to Claude Code: it works on its own in a folder of the sandbox for up to ${config.minutes} minutes, reading, changing and running the code and its tests, and ends with a summary of what it changed. Give it the whole request: it sees nothing else. It leaves its changes in the folder without committing, so check its summary and the diff before you push. carry_on: true carries on its last session in that folder in this task, after it ran out of time or to fix what you found.`,
          access: "write",
          label: "Handing it to Claude Code",
          schema: z.object({
            dir: Folder.describe(
              "The folder it works in, relative to the sandbox's home, e.g. repos/hatbot",
            ),
            request: z.string().min(1).max(20_000).describe("What to do, in full"),
            carry_on: z
              .boolean()
              .default(false)
              .describe("Carry on its last session in this folder"),
          }),
          // It reads code, issues and pages strangers wrote, and says what it likes about them.
          untrusted: true,
          describe: ({ dir, request }) => {
            const line = request.trim().split("\n")[0] ?? "";
            return `Claude Code in ${dir}: ${line.length > 100 ? `${line.slice(0, 99)}…` : line}`;
          },
          policy: (_, call) =>
            call.task
              ? allow()
              : block(
                  "Claude Code runs in a task: start one with run_task and have it call claude_code.",
                ),
          run: async ({ dir, request, carry_on }, call) => {
            if (!call.task) throw new PluginError("Claude Code runs in a task.");
            const key = `task-${call.task.id}`;
            const desktop = d.desktop.withSignal?.(call.signal) ?? d.desktop;
            try {
              const there = await desktop.exec(`test -d ${sh(dir)}`, 20);
              if (there.exitCode !== 0)
                throw new PluginError(
                  `There's no folder ${dir} in the sandbox: check the repo out or make it first.`,
                );
              const resume = carry_on ? d.claude.last(key, dir) : null;
              if (carry_on && !resume)
                throw new PluginError(
                  `Claude Code hasn't worked in ${dir} in this task yet, so there's nothing to carry on.`,
                );
              const work = () =>
                d.claude.run({
                  dir,
                  prompt: request,
                  system: SYSTEM,
                  tools: TOOLS,
                  bash: true,
                  resume,
                  key,
                  signal: call.signal,
                  onActivity: call.progress,
                });
              // It can take half an hour: the task's slot is free for others meanwhile.
              const r = await (call.away ? call.away(work) : work());
              const status = await desktop.exec(
                `cd -- ${sh(dir)} && git rev-parse --git-dir >/dev/null 2>&1 && git status --short | head -c 4000`,
                30,
              );
              const changed = status.exitCode === 0 && status.output.trim();
              return [
                r.ok ? r.text.trim() || "It said nothing." : r.text,
                `(${runStats(r)})`,
                changed ? `git status --short in ${dir}:\n${changed}` : "",
              ]
                .filter(Boolean)
                .join("\n\n");
            } catch (err) {
              if (err instanceof DesktopError) throw new PluginError(err.message);
              throw err;
            }
          },
        }),
      ];
      return ready(tools, {
        guidance:
          "claude_code hands code work to Claude Code, which works on its own in a sandbox folder on the owner's Claude subscription and leaves its changes there. For bigger changes to a repo: check it out with github_checkout or forgejo_checkout, have claude_code make the change in that folder, check its summary and the diff, then push it to a new branch with github_push or forgejo_push and open a pull request with github_open_pr or forgejo_open_pr. A new box, or a big change to one, goes to box_claude. Quick edits and one-off scripts stay with code_run and box_edit.",
        test: async () => {
          const version = await d.claude.version();
          const key = "test";
          try {
            // No tools: it only answers, from the sandbox's home.
            const r = await d.claude.run({
              dir: ".",
              prompt: "Say OK.",
              tools: [],
              key,
              signal: AbortSignal.timeout(3 * 60_000),
              model: "haiku",
              minutes: 2,
            });
            if (!r.ok) throw new PluginError(r.text);
            const used = r.usage.fiveHour;
            return `Claude Code ${version.split(" ")[0]} works${used === undefined ? "." : `; your plan's 5-hour use is ${Math.round(used * 100)}%.`}`;
          } finally {
            await d.claude.forget(key);
          }
        },
        stop: () => d.claude.configure(null),
      });
    },
  });
