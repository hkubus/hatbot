// Money and model names, the same on every page.

/** Dollars to the cent; a cost under half a cent shows as "<$0.01", not "$0.00". */
export const usd = (v: number) => (v > 0 && v < 0.005 ? "<$0.01" : `$${v.toFixed(2)}`);

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-haiku-4-5": "Haiku 4.5",
};

/** "Opus 5.5" for claude-opus-5-5; an id it doesn't know stays as it is. */
export const modelName = (id: string) => MODEL_NAMES[id] ?? id;
