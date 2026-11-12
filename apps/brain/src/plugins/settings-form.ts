// A plugin's settings as a form, from its zod schema, for the plugins the web app wasn't built with.
import type { PluginChoice, PluginField } from "@hatbot/shared";
import { z } from "zod";

/** The parts of JSON Schema that zod writes and a form can use. */
type Schema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

const described = new WeakMap<object, PluginField[]>();

export function settingsForm(schema: z.ZodType): PluginField[] {
  let form = described.get(schema);
  if (!form) {
    try {
      const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
      form = fieldsOf(json as Schema, []);
    } catch {
      // One zod can't describe, or another zod's: its switch and environment still work.
      form = [];
    }
    described.set(schema, form);
  }
  return form;
}

function fieldsOf(s: Schema, path: string[]): PluginField[] {
  if (s.type !== "object" || !s.properties) return [];
  return Object.entries(s.properties).flatMap(([key, p]) => fieldOf(p, [...path, key]) ?? []);
}

function fieldOf(s: Schema, path: string[]): PluginField | null {
  const bare = withoutNull(s);
  if (!bare || bare.schema.const !== undefined) return null;
  const { schema: one, nullable } = bare;
  const label = s.title || s.description || one.title || one.description || words(path.at(-1));
  const choices = choicesOf(one);
  if (choices) return nullable ? null : { path, label, kind: "choice", choices };
  switch (one.type) {
    case "boolean":
      return nullable ? null : { path, label, kind: "switch" };
    case "string":
      return { path, label, kind: "text", max: one.maxLength ?? null, nullable };
    case "number":
    case "integer":
      return {
        path,
        label,
        kind: "number",
        integer: one.type === "integer",
        min: bound(one.minimum),
        max: bound(one.maximum),
        nullable,
      };
    case "array": {
      const items = one.items && withoutNull(one.items);
      if (nullable || !items || items.nullable) return null;
      const picks = choicesOf(items.schema);
      if (picks) return { path, label, kind: "picks", choices: picks };
      const type = items.schema.type;
      if (type === "string") return { path, label, kind: "list", numbers: false };
      if (type === "number" || type === "integer")
        return { path, label, kind: "list", numbers: true };
      return null;
    }
    case "object": {
      const fields = nullable ? [] : fieldsOf(one, path);
      return fields.length ? { path, label, kind: "group", fields } : null;
    }
    default:
      return null;
  }
}

/** The schema without null, and whether it takes null; null for unions a form can't show. */
function withoutNull(s: Schema): { schema: Schema; nullable: boolean } | null {
  if (Array.isArray(s.type)) {
    const types = s.type.filter((t) => t !== "null");
    const [type] = types;
    return types.length === 1
      ? { schema: { ...s, type }, nullable: types.length < s.type.length }
      : null;
  }
  if (!s.anyOf) return { schema: s, nullable: false };
  const { anyOf, ...rest } = s;
  const some = anyOf.filter((o) => o.type !== "null");
  const nullable = some.length < anyOf.length;
  // A union of literals is a choice.
  if (some.length > 1 && some.every((o) => o.const !== undefined))
    return { schema: { ...rest, enum: some.map((o) => o.const) }, nullable };
  const [only] = some;
  return some.length === 1 && only ? { schema: { ...rest, ...only }, nullable } : null;
}

function choicesOf(s: Schema): PluginChoice[] | null {
  const values = s.enum?.filter((v) => typeof v === "string" || typeof v === "number");
  if (!values || values.length !== s.enum?.length || values.length < 2) return null;
  return values.map((value) => ({
    value,
    label: typeof value === "string" && /^[a-zA-Z _-]+$/.test(value) ? words(value) : String(value),
  }));
}

/** zod gives every integer the safe integers' bounds. */
const bound = (n: number | undefined) =>
  n === undefined || Math.abs(n) >= Number.MAX_SAFE_INTEGER ? null : n;

/** maxResults or max_results: "Max results". */
function words(key = "") {
  const w = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}
