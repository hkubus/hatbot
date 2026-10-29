// The sandbox shell is its own throwaway user on the desktop container: no browser profile, no screen,
// no secrets and no LAN, but it does reach the internet.

import {
  definePlugin,
  needsSetup,
  PluginError,
  ready,
  type Sandbox,
  SandboxError,
  tool,
} from "@hatbot/plugin-sdk";
import { z } from "zod";

export const codePlugin = definePlugin({
  id: "code",
  name: "Code",
  description: "Run commands and scripts in the desktop's sandbox",
  config: z.object({}),
  uses: ["sandbox"],
  start: ({ files, optional }) => {
    const sandbox = optional<Sandbox>("sandbox");
    if (!files || !sandbox?.configured)
      return needsSetup("The desktop isn't set up yet; the sandbox runs on it.");
    const { attachments } = files;
    const tools = [
      tool({
        name: "code_run",
        description:
          "Run a bash command in the sandbox: a throwaway Linux user on the desktop container with Python 3 (numpy, pandas, matplotlib, openpyxl), jq, sqlite3, poppler-utils and git. Use it to compute, convert or analyse files, make files and images, or test a snippet. The working directory is the sandbox's home and persists between calls; files: copies the owner's attachments into in/ first. It reaches the internet but not your LAN, and can't see the browser or the screen. send_file hands the owner a file it made.",
        access: "write",
        label: "Running code",
        schema: z.object({
          command: z.string().min(1).max(20_000).describe("A bash command or script"),
          timeout_s: z
            .number()
            .int()
            .min(1)
            .max(600)
            .default(60)
            .describe("Seconds before it's killed"),
          files: z
            .array(z.number().int().positive())
            .max(10)
            .default([])
            .describe("Attachment ids to copy into in/ before running"),
        }),
        // The sandbox reaches the internet and keeps its files across chats and tasks, so what a
        // command prints may be what some page said, today or last week.
        untrusted: true,
        describe: ({ command }) => {
          const line = command.trim().split("\n")[0] ?? "";
          return line.length > 120 ? `${line.slice(0, 119)}…` : line;
        },
        run: async ({ command, timeout_s, files }, call) => {
          // A cancelled task's (or stopped reply's) command and copies stop with it.
          const desktop = sandbox.withSignal?.(call.signal) ?? sandbox;
          try {
            const copied: string[] = [];
            for (const id of files) {
              const a = attachments.get(id);
              const bytes = a && (await attachments.bytes(id));
              if (!a || !bytes) throw new PluginError(`There's no attachment #${id}.`);
              const path = `in/${a.id}-${a.name.replace(/[^\w.-]+/g, "_")}`;
              await desktop.putFile(path, bytes);
              copied.push(path);
            }
            const r = await desktop.exec(command, timeout_s);
            const head = r.timedOut ? `Killed after ${timeout_s} s.` : `Exit code ${r.exitCode}`;
            const out = `${head}\n${r.output}`;
            return copied.length ? `Copied in: ${copied.join(", ")}\n${out}` : out;
          } catch (err) {
            if (err instanceof SandboxError) throw new PluginError(err.message);
            throw err;
          }
        },
      }),
    ];
    return ready(tools, {
      guidance:
        "code_run runs commands in a sandbox on the desktop container: for computing, converting and analysing files and quick scripts. Its home persists. The owner's attachments go in with files: [ids]; send_file hands back what you made.",
      test: async () => {
        try {
          const r = await sandbox.exec("python3 --version; whoami", 20);
          return r.output.replace(/\n/g, ", ");
        } catch (err) {
          throw new PluginError((err as Error).message);
        }
      },
    });
  },
});
