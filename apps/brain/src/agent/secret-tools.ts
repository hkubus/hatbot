// Secrets the owner keeps for the bots: typed in on an approval the model never sees the answer to,
// and placed in files by name.
import { definePlugin, PluginError, ready, tool } from "@hatbot/plugin-sdk";
import { SecretName, secretPlaceholder } from "@hatbot/shared";
import { z } from "zod";
import type { Secrets } from "../secrets";

const PLACE =
  "write {{secret:NAME}} where it goes in a file you write (ssh_write_file, computer_put_file, code_write_file), and its value goes in as the file is written";

export function secretsPlugin(secrets: Secrets) {
  const tools = [
    tool({
      name: "secrets_ask",
      description: `Ask the owner to type in a secret, such as an API key, token or password, kept under name. You never see it: ${PLACE}. Never ask for one in the chat. To replace one that's kept, ask for it again.`,
      schema: z.object({
        name: SecretName.describe("What it's kept as, like GITEA_TOKEN"),
        why: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe("For the owner: what it is, and where it goes"),
      }),
      access: "own",
      places: ["chat", "task"],
      incognito: false,
      label: "Asking you for a secret",
      describe: ({ name }) => name,
      run: async ({ name, why }, call) => {
        if (!call.approve) throw new PluginError("Secrets can't be asked for here.");
        const r = await call.approve(
          { tool: "secrets_ask", input: { name }, what: `Type in ${name}`, why, secret: name },
          call.signal,
        );
        if (r.isError) throw new PluginError(r.content);
        return `The owner typed it in. Write ${secretPlaceholder(name)} where it goes.${r.content}`;
      },
    }),
    tool({
      name: "secrets_list",
      description: `The secrets the owner keeps for you, by name, without their values: ${PLACE}. The owner sees and changes them in Settings → Secrets.`,
      schema: z.object({}),
      access: "read",
      places: ["chat", "task"],
      label: "Looking at your secrets",
      run: async () => {
        const kept = secrets.vault();
        return kept.length
          ? kept.map((s) => `${secretPlaceholder(s.name)}, set ${s.setAt.slice(0, 10)}`).join("\n")
          : "None yet. Ask the owner for one with secrets_ask.";
      },
    }),
  ];
  return definePlugin({
    id: "secrets",
    name: "Secrets",
    description: "",
    internal: true,
    config: z.object({}),
    start: () =>
      ready(tools, {
        guidance:
          "Never ask for a key, token or password in the chat, and never write one out: ask for it with secrets_ask, and put it in files as {{secret:NAME}}. A file's secret read back shows as its placeholder. To keep a secret a file holds without reading it, such as a token a command made, use a _keep_secret tool.",
      }),
  });
}
