// The settings form for a plugin the app wasn't built with, from the fields the brain describes.
import type { PluginField } from "@hatbot/shared";
import { Fragment, type ReactNode, useState } from "react";
import { useAction } from "./action";
import { ApiError, errorText } from "./api";
import { useLeaveGuard } from "./confirm";
import { Switch } from "./switch";
import { Panel, SaveBar, Seg, Select } from "./ui";

type Value = string | number | boolean | (string | number)[];
/** Each field's value as its input holds it, by its path's key. */
export type Draft = Record<string, Value>;

export const keyOf = (path: string[]) => JSON.stringify(path);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function valueAt(config: unknown, path: string[]): unknown {
  let at = config;
  for (const key of path)
    at = at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
  return at;
}

export function draftOf(fields: PluginField[], config: unknown, into: Draft = {}): Draft {
  for (const f of fields) {
    const v = valueAt(config, f.path);
    const key = keyOf(f.path);
    if (f.kind === "group") draftOf(f.fields, config, into);
    else if (f.kind === "switch") into[key] = v === true;
    else if (f.kind === "text") into[key] = typeof v === "string" ? v : "";
    else if (f.kind === "number") into[key] = typeof v === "number" ? String(v) : "";
    else if (f.kind === "choice")
      into[key] = typeof v === "string" || typeof v === "number" ? v : (f.choices[0]?.value ?? "");
    else if (f.kind === "picks") into[key] = Array.isArray(v) ? v : [];
    else into[key] = Array.isArray(v) ? v.join("\n") : "";
  }
  return into;
}

/** Undefined takes it out, so its default applies. */
function put(config: Record<string, unknown>, path: string[], value: unknown) {
  let at = config;
  for (const key of path.slice(0, -1)) {
    const next = at[key];
    const copy = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    at[key] = copy;
    at = copy;
  }
  const last = path.at(-1) as string;
  if (value === undefined) delete at[last];
  else at[last] = value;
}

/** The settings with the form's values in; ones it doesn't show stay as they were. */
export function configFrom(
  fields: PluginField[],
  config: unknown,
  draft: Draft,
): { config: Record<string, unknown> } | { at: string[]; error: string } {
  const out =
    config && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  const fill = (list: PluginField[]): { at: string[]; error: string } | null => {
    for (const f of list) {
      if (f.kind === "group") {
        const wrong = fill(f.fields);
        if (wrong) return wrong;
        continue;
      }
      const v = draft[keyOf(f.path)];
      if (f.kind === "text") {
        // One you didn't change stays as it was: a separator that ends in a space, or an optional
        // setting with none, which "" would fail a .url() or .min(1) for. What you typed is trimmed.
        const was = valueAt(config, f.path);
        if (String(v ?? "") === (typeof was === "string" ? was : "")) continue;
        const text = String(v ?? "").trim();
        put(out, f.path, !text && f.nullable ? null : text);
      } else if (f.kind === "number") {
        const text = String(v ?? "").trim();
        const n = Number(text);
        if (text && !Number.isFinite(n)) return { at: f.path, error: "A number." };
        put(out, f.path, text ? n : f.nullable ? null : undefined);
      } else if (f.kind === "list") {
        const lines = String(v ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const list = f.numbers ? lines.map(Number) : lines;
        if (list.some((n) => typeof n === "number" && !Number.isFinite(n)))
          return { at: f.path, error: "One number a line." };
        put(out, f.path, list);
      } else if (f.kind === "picks") {
        const picked = Array.isArray(v) ? v : [];
        put(
          out,
          f.path,
          f.choices.filter((c) => picked.includes(c.value)).map((c) => c.value),
        );
      } else put(out, f.path, v);
    }
    return null;
  };
  const wrong = fill(fields);
  return wrong ?? { config: out };
}

/** The field the brain's `config.…` refers to, or one of its lists' items. */
function fieldAt(fields: PluginField[], name: string): PluginField | null {
  for (const f of fields) {
    if (f.kind === "group") {
      const inner = fieldAt(f.fields, name);
      if (inner) return inner;
      continue;
    }
    const own = ["config", ...f.path].join(".");
    if (name === own || name.startsWith(`${own}.`)) return f;
  }
  return null;
}

export function PluginForm({
  fields,
  config,
  save,
}: {
  fields: PluginField[];
  config: unknown;
  save: (config: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftOf(fields, config));
  const [wrong, setWrong] = useState<{ key: string; error: string } | null>(null);
  const { busy, error, setError, run } = useAction();
  const changed = !same(draft, draftOf(fields, config));
  useLeaveGuard(changed);

  const set = (path: string[], value: Value) => {
    setDraft({ ...draft, [keyOf(path)]: value });
    if (wrong?.key === keyOf(path)) setWrong(null);
  };
  const submit = () => {
    setWrong(null);
    const built = configFrom(fields, config, draft);
    if ("error" in built) return setWrong({ key: keyOf(built.at), error: built.error });
    void run(
      () => save(built.config),
      (err) => {
        const name = err instanceof ApiError ? (err.data as { field?: unknown })?.field : null;
        const f = typeof name === "string" ? fieldAt(fields, name) : null;
        if (f) setWrong({ key: keyOf(f.path), error: errorText(err) });
        else setError(errorText(err, "Couldn't save."));
      },
    );
  };

  const render = (list: PluginField[]) =>
    list.map((f) => {
      const key = keyOf(f.path);
      const v = draft[key];
      const said = wrong?.key === key && <div className="form-error">{wrong.error}</div>;
      let input: ReactNode;
      if (f.kind === "group")
        return (
          <Fragment key={key}>
            <h3 className="section-title">{f.label}</h3>
            {render(f.fields)}
          </Fragment>
        );
      if (f.kind === "switch")
        input = (
          <div className="form-row">
            <span className="label">{f.label}</span>
            <Switch on={v === true} onChange={(on) => set(f.path, on)} />
          </div>
        );
      else if (f.kind === "choice") {
        const options = f.choices.map((c) => [c.value, c.label] as const);
        input = (
          <>
            <span className="label">{f.label}</span>
            {options.length <= 4 ? (
              <Seg
                value={v as string | number}
                options={options}
                onChange={(c) => set(f.path, c)}
              />
            ) : (
              <Select
                className="field"
                label={f.label}
                value={v as string | number}
                options={options}
                onChange={(c) => set(f.path, c)}
              />
            )}
          </>
        );
      } else if (f.kind === "picks") {
        const picked = Array.isArray(v) ? v : [];
        input = (
          <>
            <span className="label">{f.label}</span>
            {f.choices.map((c) => (
              <div className="form-row" key={String(c.value)}>
                <span>{c.label}</span>
                <Switch
                  on={picked.includes(c.value)}
                  onChange={(on) =>
                    set(f.path, on ? [...picked, c.value] : picked.filter((x) => x !== c.value))
                  }
                />
              </div>
            ))}
          </>
        );
      } else if (f.kind === "list")
        input = (
          <label>
            <span className="label">{f.label}</span>
            <textarea
              className="field"
              rows={Math.max(3, String(v).split("\n").length + 1)}
              placeholder="One a line"
              spellCheck={false}
              value={String(v ?? "")}
              onChange={(e) => set(f.path, e.target.value)}
            />
          </label>
        );
      else
        input = (
          <label>
            <span className="label">{f.label}</span>
            <input
              className="field"
              type={f.kind === "number" ? "number" : "text"}
              min={f.kind === "number" ? (f.min ?? undefined) : undefined}
              max={f.kind === "number" ? (f.max ?? undefined) : undefined}
              step={f.kind === "number" ? (f.integer ? 1 : "any") : undefined}
              maxLength={f.kind === "text" ? (f.max ?? undefined) : undefined}
              autoComplete="off"
              value={String(v ?? "")}
              onChange={(e) => set(f.path, e.target.value)}
            />
          </label>
        );
      return (
        <Fragment key={key}>
          {input}
          {said}
        </Fragment>
      );
    });

  return (
    <Panel title="Settings" className="form">
      {render(fields)}
      <SaveBar error={error} disabled={busy || !changed} onSave={submit} />
    </Panel>
  );
}
