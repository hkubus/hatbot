// Models from OpenRouter, or any API that speaks OpenAI's chat completions.
import { definePlugin, needsSetup, PluginError, ready } from "@hatbot/plugin-sdk";
import { z } from "zod";
import { catalogue, OPENROUTER, OpenAIModelClient } from "./client";

const ModelId = z.string().trim().min(1).max(200);

export const openaiPlugin = definePlugin({
  id: "openai",
  name: "OpenAI-compatible",
  description: "Models from OpenRouter, or any API that speaks OpenAI's chat completions",
  env: [
    { name: "OPENAI_API_KEY", secret: true, hint: "sk-or-…" },
    { name: "OPENAI_BASE_URL", optional: true, hint: OPENROUTER },
  ],
  config: z.object({
    /** None: every model it lists that takes tools. */
    models: z.array(ModelId).max(200).default([]),
  }),
  start: async ({ env, config, fetch }) => {
    const key = env.OPENAI_API_KEY;
    if (!key) return needsSetup("Add an API key below: OpenRouter's, or your API's.");
    const baseUrl = (env.OPENAI_BASE_URL || OPENROUTER).replace(/\/+$/, "");
    const api = { baseUrl, key, fetch };
    const list = () =>
      catalogue(api, config.models).catch((err) => {
        throw new PluginError(
          `It couldn't list the models: ${err instanceof Error ? err.message : err}.`,
        );
      });
    const models = await list();
    if (!models.length)
      return needsSetup(
        config.models.length
          ? "It offers none of the models below."
          : "It offers no model that takes tools.",
      );
    return ready([], {
      models: new OpenAIModelClient({ ...api, models }),
      test: async () => `It offers ${(await list()).length} of the models.`,
    });
  },
});
