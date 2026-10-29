import type { ModelCapabilities, ModelInfo } from "@hatbot/plugin-sdk";

const ALL: ModelCapabilities = {
  computerUse: true,
  webSearch: true,
  webFetch: true,
  images: true,
  pdfs: true,
};

/** USD per million tokens. */
export const MODELS: ModelInfo[] = [
  {
    id: "claude-haiku-5-5",
    name: "Haiku 5.5",
    // Its long-prompt cache-read price isn't published separately; assumed 5x like the rest.
    price: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
    },
    capabilities: ALL,
  },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5",
    price: { input: 4, output: 20, cacheRead: 0.2 },
    capabilities: { ...ALL, progressNotes: true },
    // What a declined request may be answered by, with `fallbacks: "default"`.
    fallbacks: [
      {
        id: "claude-opus-5",
        name: "Opus 5",
        price: { input: 5, output: 25, cacheRead: 0.5 },
        capabilities: ALL,
      },
      {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        price: { input: 5, output: 25, cacheRead: 0.5 },
        capabilities: ALL,
      },
    ],
  },
];
