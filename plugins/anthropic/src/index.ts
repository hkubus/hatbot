// Claude, through Anthropic's API: Hatbot's default models.
import { definePlugin, needsSetup, PluginError, ready } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { AnthropicModelClient, checkKey } from "./client";

export { MODELS } from "./catalogue";
export { AnthropicModelClient, retryAfterMs, retryable } from "./client";

export const anthropicPlugin = definePlugin({
  id: "anthropic",
  name: "Anthropic",
  description: "Claude models, through Anthropic's API",
  env: [{ name: "ANTHROPIC_API_KEY", secret: true, hint: "sk-ant-…" }],
  config: z.object({}),
  defaultOn: true,
  start: ({ env }) => {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return needsSetup("Add your Anthropic API key below.");
    return ready([], {
      models: new AnthropicModelClient(key),
      test: async () => {
        try {
          await checkKey(key);
        } catch (err) {
          throw new PluginError(
            `The key doesn't work: ${err instanceof Error ? err.message : err}`,
          );
        }
        return "The key works.";
      },
    });
  },
});
