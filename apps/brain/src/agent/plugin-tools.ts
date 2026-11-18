// Plugins from the chat and tasks: looking at them, and turning them on or off, setting them up and
// choosing each bot's, as Settings → Safety's "Changing plugins" says.
import { ask, block, definePlugin, ready, tool } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { BotPlugins, PluginChange, type PluginControl } from "../plugins/control";

const PluginId = z.object({ id: z.string().min(1).max(40).describe("The plugin's id") });
const ASKS = "It changes what Hatbot connects to, and what it can do.";

export function pluginsPlugin(control: () => PluginControl) {
  const tools = [
    tool({
      name: "plugins_list",
      description: "Every plugin: whether it's on, ready or what it needs, and what it's for.",
      schema: z.object({}),
      access: "read",
      places: ["chat", "task"],
      deferred: true,
      label: "Looking at plugins",
      run: async () => control().list(),
    }),
    tool({
      name: "plugins_settings",
      description:
        "One plugin's settings, their fields, and the values it reads. Secrets show only whether they're set.",
      schema: PluginId,
      access: "read",
      places: ["chat", "task"],
      deferred: true,
      label: "Looking at a plugin's settings",
      describe: ({ id }) => id,
      run: async ({ id }) => control().settingsOf(id),
    }),
    tool({
      name: "plugins_bots",
      description: "Which plugins each bot has.",
      schema: z.object({}),
      access: "read",
      places: ["chat", "task"],
      deferred: true,
      label: "Looking at bots' plugins",
      run: async () => control().bots(),
    }),
    tool({
      name: "plugins_test",
      description:
        "Try a plugin that's ready, as its Test button does. What it says can come from the service: untrusted.",
      schema: PluginId,
      access: "read",
      places: ["chat", "task"],
      deferred: true,
      untrusted: true,
      label: "Testing a plugin",
      describe: ({ id }) => id,
      run: async ({ id }) => control().test(id),
    }),
    tool({
      name: "plugins_change",
      description:
        "Turn a plugin on or off, or change its settings or the values it reads that aren't secret (an address, say). Look at plugins_settings first. The owner enters secrets, and installs plugins, in Settings → Plugins.",
      schema: PluginChange,
      access: "write",
      places: ["chat", "task"],
      deferred: true,
      kind: "plugins",
      label: "Changing a plugin",
      describe: (c) => control().describe(c),
      target: ({ id }) => `plugin:${id}`,
      policy: (c) => {
        const why = control().problem(c);
        return why ? block(why) : ask(ASKS);
      },
      run: async (c) => control().change(c),
    }),
    tool({
      name: "plugins_for_bot",
      description:
        "Choose which plugins a bot has: every plugin's id it should have, or null for every plugin that's on.",
      schema: BotPlugins,
      access: "write",
      places: ["chat", "task"],
      deferred: true,
      kind: "plugins",
      label: "Changing a bot's plugins",
      describe: (b) => control().describeBot(b),
      target: ({ bot }) => `bot:${bot}`,
      policy: (b) => {
        const why = control().botProblem(b);
        return why ? block(why) : ask(ASKS);
      },
      run: async (b) => control().setBot(b),
    }),
  ];
  return definePlugin({
    id: "plugins",
    name: "Plugins",
    description: "",
    internal: true,
    config: z.object({}),
    start: () =>
      ready(tools, {
        prompt: {
          chat: `- You can look at plugins and, as the owner allows, turn them on or off, set them up and choose each bot's: find the tools with tool_search_tool_regex ("plugins_").`,
          task: `- Plugins' tools load when you need them: find them with tool_search_tool_regex ("plugins_").`,
        },
      }),
  });
}
