import type { ModelOption } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { api } from "./api";
import { modelName } from "./format";

/** The models offered by the providers that are on; null until they're loaded. */
export function useModels(): ModelOption[] | null {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    api<ModelOption[]>("/models").then(setModels, () => {});
  }, []);
  return models;
}

export const modelNameIn = (models: ModelOption[] | null, id: string) =>
  models?.find((m) => m.id === id)?.name ?? modelName(id);

/** A picker's choices; the one set now stays among them even when no provider offers it. */
export function modelOptions(
  models: ModelOption[] | null,
  current: string | null | undefined,
  only: (m: ModelOption) => boolean = () => true,
): [string, string][] {
  const list = (models ?? []).filter(only).map((m): [string, string] => [m.id, m.name]);
  if (current && !list.some(([id]) => id === current))
    list.push([current, modelNameIn(models, current)]);
  return list;
}

/** The chat's choices: any but the expert model can ask it for hard parts. */
export const chatModelOptions = (
  models: ModelOption[] | null,
  current: string | null,
  expert: string,
) =>
  modelOptions(models, current).map(([id, name]): [string, string] => [
    id,
    id === expert ? name : `${name}, asks ${modelNameIn(models, expert)} for hard parts`,
  ]);
