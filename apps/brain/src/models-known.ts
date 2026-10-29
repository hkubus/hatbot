import type { ModelInfo } from "@hatbot/plugin-sdk";

/** Every model a provider that started gave: a model's price and name don't change with who asks. */
const known = new Map<string, ModelInfo>();

export function addModels(models: ModelInfo[]) {
  for (const m of models) {
    known.set(m.id, m);
    if (m.fallbacks) addModels(m.fallbacks);
  }
}

export const modelInfo = (id: string): ModelInfo | null =>
  known.get(id) ?? known.get(id.replace(/-\d{8}$/, "")) ?? null;

export const modelName = (id: string) => modelInfo(id)?.name ?? id;

export const hasFallbacks = (id: string) => Boolean(modelInfo(id)?.fallbacks?.length);

/** Whether it writes notes between tools as it works (`display: "updates"`). */
export const progressNotes = (id: string) => Boolean(modelInfo(id)?.capabilities.progressNotes);

const ROLES = ["chatModel", "taskModel", "desktopModel", "smallModel", "expertModel"] as const;

/** What's wrong with the models a change picks, among those on offer, as a 400's body; null when nothing. */
export function modelProblem(
  change: Partial<Record<(typeof ROLES)[number], string | null>>,
  offered: ModelInfo[],
): { error: string; field: string } | null {
  for (const field of ROLES) {
    const id = change[field];
    if (!id) continue;
    const info = offered.find((m) => m.id === id);
    if (!info) return { error: "No model provider offers that model.", field };
    if (field === "desktopModel" && !info.capabilities.computerUse)
      return { error: "That model can't use a computer.", field };
  }
  return null;
}
