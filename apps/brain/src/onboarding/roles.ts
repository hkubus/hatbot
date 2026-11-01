import type { ModelInfo } from "@hatbot/plugin-sdk";
import { DEFAULT_SETTINGS, type Settings } from "../settings";

type Roles = Pick<
  Settings,
  "chatModel" | "taskModel" | "desktopModel" | "smallModel" | "expertModel"
>;

const output = (m: ModelInfo) => m.price?.output ?? Number.POSITIVE_INFINITY;

/**
 * The roles for a provider's catalogue: Claude's defaults when it has them, under its own ids (OpenRouter
 * names them anthropic/claude-…), or else its cheapest priced model for the everyday roles and its
 * dearest for the hard parts. Roles it can't fill keep what they had.
 */
export function rolesFor(models: ModelInfo[], was: Roles): Partial<Roles> {
  const norm = (id: string) => id.replace(/^.*\//, "").replaceAll("-", ".");
  const like = (id: string) => models.find((m) => norm(m.id) === norm(id));
  const haiku = like(DEFAULT_SETTINGS.chatModel);
  const opus = like(DEFAULT_SETTINGS.expertModel);
  // Free models are rate-limited too hard to chat on.
  const priced = models
    .filter((m) => m.price && m.price.output > 0)
    .sort((a, b) => output(a) - output(b));
  const cheap = haiku ?? priced[0] ?? models[0];
  const dear = opus ?? priced.at(-1) ?? cheap;
  if (!cheap || !dear) return {};
  const desktop = [haiku, cheap, ...models].find((m) => m?.capabilities.computerUse);
  return {
    chatModel: cheap.id,
    taskModel: cheap.id,
    smallModel: cheap.id,
    expertModel: dear.id,
    desktopModel: desktop?.id ?? was.desktopModel,
  };
}
