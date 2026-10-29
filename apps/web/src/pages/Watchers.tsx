import {
  HATBOT_ID,
  MIN_RENDER_WATCH_MINUTES,
  minWatchMinutes,
  type WatchCondition,
  type Watcher,
  type WatcherValue,
  type WatchPreview,
  type WatchSource,
} from "@hatbot/shared";
import { useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import {
  BotPicker,
  deleteText,
  EverySelect,
  OnPanel,
  Runs,
  TaintedNote,
  useListed,
} from "../automations";
import { ask, useLeaveGuard } from "../confirm";
import { useStoredForm } from "../form";
import { stamp } from "../format";
import { Icon } from "../icons";
import { LoadError, PageLoad, useLoad } from "../load";
import { navigate } from "../router";
import { putWatcher, trustWatcher, useStore } from "../store";
import { Switch } from "../switch";
import type { Toast } from "../toast";
import { BackHead, Panel, SaveBar, Seg, Select } from "../ui";

const EVERY = [5, 15, 30, 60, 180, 360, 720, 1440];
const WHEN: [WatchCondition["when"], string][] = [
  ["changed", "Changes"],
  ["contains", "Contains"],
  ["missing", "Doesn't contain"],
  ["below", "Below"],
  ["above", "Above"],
];
type Pick = "page" | "selector" | "path";

export const patchWatcher = async (id: number, body: object) => {
  const w = await api<Watcher>(`/watchers/${id}`, { method: "PATCH", body });
  putWatcher(w);
  return w;
};

type Form = {
  name: string;
  kind: WatchSource["kind"];
  url: string;
  render: boolean;
  tool: string;
  input: string;
  pick: Pick;
  selector: string;
  path: string;
  pattern: string;
  when: WatchCondition["when"];
  text: string;
  value: string;
  everyMinutes: number;
  once: boolean;
  prompt: string;
  botId: string;
};

export const blank: Form = {
  name: "",
  kind: "page",
  url: "",
  render: false,
  tool: "",
  input: "{}",
  pick: "selector",
  selector: "",
  path: "",
  pattern: "",
  when: "changed",
  text: "",
  value: "",
  everyMinutes: 60,
  once: false,
  prompt: "",
  botId: HATBOT_ID,
};

const formOf = (w: Watcher): Form => ({
  name: w.name,
  kind: w.source.kind,
  url: w.source.url ?? "",
  render: Boolean(w.source.render),
  tool: w.source.tool ?? "",
  input: JSON.stringify(w.source.input ?? {}, null, 2),
  pick: w.source.selector ? "selector" : w.source.path ? "path" : "page",
  selector: w.source.selector ?? "",
  path: w.source.path ?? "",
  pattern: w.source.pattern ?? "",
  when: w.condition.when,
  text: "text" in w.condition ? w.condition.text : "",
  value: "value" in w.condition ? String(w.condition.value) : "",
  everyMinutes: w.everyMinutes,
  once: w.once,
  prompt: w.prompt,
  botId: w.botId,
});

export function sourceOf(f: Form): WatchSource | string {
  let input: Record<string, unknown> = {};
  if (f.kind === "tool") {
    try {
      input = JSON.parse(f.input || "{}");
    } catch {
      return "The tool's input isn't JSON.";
    }
  }
  return {
    kind: f.kind,
    ...(f.kind === "page"
      ? { url: f.url.trim(), ...(f.render ? { render: true } : {}) }
      : { tool: f.tool, input }),
    ...(f.pick === "selector" && f.selector.trim() ? { selector: f.selector.trim() } : {}),
    ...(f.pick === "path" && f.path.trim() ? { path: f.path.trim() } : {}),
    ...(f.pattern ? { pattern: f.pattern } : {}),
  };
}

export function bodyOf(f: Form): { source: WatchSource; condition: WatchCondition } | string {
  const source = sourceOf(f);
  if (typeof source === "string") return source;
  let condition: WatchCondition;
  if (f.when === "changed") condition = { when: "changed" };
  else if (f.when === "contains" || f.when === "missing") {
    if (!f.text.trim()) return "Say what text to look for.";
    condition = { when: f.when, text: f.text.trim() };
  } else {
    const value = Number(f.value);
    if (f.value.trim() === "" || !Number.isFinite(value)) return "Give a number.";
    condition = { when: f.when, value };
  }
  return { source, condition };
}

const fieldsOf = (f: Form) => ({
  name: f.name.trim(),
  prompt: f.prompt.trim(),
  everyMinutes: f.everyMinutes,
  once: f.once,
  botId: f.botId,
});

/** A watcher switched off for counting too often isn't a failed read, and isn't shown as one. */
export function trouble(w: Watcher): { short: string; long: string } | null {
  if (!w.lastError) return null;
  if (w.errors === 0) return { short: "Off", long: w.lastError };
  const times = w.errors > 1 ? ` (${w.errors} times in a row)` : "";
  return { short: "Can't read", long: `Can't read it: ${w.lastError}${times}` };
}

export function WatcherEdit({ id, toast }: { id: number | null; toast: Toast }) {
  const stored = useStore((s) => (id === null ? undefined : s.watchers[id]));
  const plugins = useStore((s) => s.plugins);
  // A change made elsewhere comes in while you haven't edited it.
  const {
    form,
    dirty,
    set: setFields,
    saved,
  } = useStoredForm<Form>(id === null ? blank : stored ? formOf(stored) : undefined);
  const [preview, setPreview] = useState<WatchPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const { busy, error, setError, run } = useAction();
  const checking = useAction();
  const acting = useAction();
  const listed = useListed("watchers", id, stored);
  // Deleted elsewhere: there's nothing left to save.
  const edited = dirty && stored !== null;
  const release = useLeaveGuard(edited);

  // Its history, again when a check finds something new.
  const history = useLoad(
    () =>
      id === null ? Promise.resolve([]) : api<WatcherValue[]>(`/watchers/${id}/values?limit=50`),
    [id, stored?.lastValue],
  );
  const values = history.data ?? [];

  if (listed.missing || !form)
    return (
      <PageLoad
        error={listed.error}
        missing={listed.missing ? "This watcher doesn't exist." : ""}
        retry={listed.load}
        back={{ label: "Automations", to: "/schedules" }}
      />
    );

  const set = (patch: Partial<Form>) => {
    setFields(patch);
    setPreview(null);
    setPreviewError("");
  };
  const readTools = Object.values(plugins)
    .filter((p) => p.enabled && p.state === "ready")
    .flatMap((p) =>
      p.tools.filter((t) => t.access === "read").map((t) => ({ ...t, plugin: p.name })),
    );
  const body = bodyOf(form);
  // Read after its scripts run, a page comes back as HTML (no JSON path) and looks less often.
  const rendered = form.kind === "page" && form.render;
  const every = EVERY.filter((m) => m >= minWatchMinutes(form));
  const fields = fieldsOf(form);
  const changed = !stored || stored.tainted || edited;
  const ready =
    Boolean(fields.name) && (form.kind === "page" ? Boolean(form.url.trim()) : Boolean(form.tool));

  const tryIt = async () => {
    setPreview(null);
    // Only where it looks: the condition isn't tried, and its errors wait for Save.
    const source = sourceOf(form);
    if (typeof source === "string") return setPreviewError(source);
    setPreviewError("");
    await run(
      async () =>
        setPreview(
          await api<WatchPreview>("/watchers/preview", { body: { source, botId: form.botId } }),
        ),
      (err) => setPreviewError(errorText(err)),
    );
  };
  const save = async () => {
    if (typeof body === "string") return setError(body);
    await run(async () => {
      if (stored) {
        const w = await patchWatcher(stored.id, { ...fields, ...body });
        saved(form, formOf(w));
        toast("Saved");
      } else {
        const w = await api<Watcher>("/watchers", { body: { ...fields, ...body } });
        putWatcher(w);
        release();
        navigate(`/watchers/${w.id}`, true);
      }
    });
  };
  // Checks what's saved: off while you have unsaved changes, and while it's checking.
  const checkNow = () =>
    checking.run(async () => {
      if (stored) putWatcher(await api<Watcher>(`/watchers/${stored.id}/check`, { body: {} }));
    });
  const remove = async () => {
    if (!stored || !(await ask({ text: deleteText(stored.name), ok: "Delete" }))) return;
    await acting.run(async () => {
      await api(`/watchers/${stored.id}`, { method: "DELETE" });
      release();
      navigate("/schedules");
    });
  };

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/schedules" label="Automations">
          {stored && (
            <>
              <button
                type="button"
                className="btn sm"
                disabled={edited || checking.busy}
                title={edited ? "Save your changes first" : undefined}
                onClick={checkNow}
              >
                <Icon name="play" />
                {checking.busy ? "Checking…" : "Check now"}
              </button>
              <button type="button" className="btn sm danger-text" onClick={remove}>
                Delete
              </button>
            </>
          )}
        </BackHead>
        {(checking.error || acting.error) && (
          <div className="form-error">{checking.error || acting.error}</div>
        )}
        {stored?.lastError && (
          <div className={stored.errors ? "form-error" : "muted"}>{trouble(stored)?.long}</div>
        )}
        {stored && (
          <OnPanel
            label="Watcher"
            on={stored.enabled}
            onChange={(enabled) =>
              acting.run(async () => {
                await patchWatcher(stored.id, { enabled });
                toast("Saved");
              })
            }
          />
        )}

        <div className="panel form">
          <label>
            <span className="label">Name</span>
            <input
              className="field"
              value={form.name}
              maxLength={80}
              placeholder="Framework 16 price"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <div className="form-row">
            <span className="label">Look at</span>
            <Seg
              value={form.kind}
              options={[
                ["page", "A page"],
                ["tool", "A plugin"],
              ]}
              onChange={(kind) =>
                set(
                  kind === "tool"
                    ? { kind, pick: form.pick === "selector" ? "path" : form.pick }
                    : { kind },
                )
              }
            />
          </div>
          {form.kind === "page" ? (
            <label>
              <span className="label">Address</span>
              <input
                className="field"
                value={form.url}
                inputMode="url"
                spellCheck={false}
                placeholder="https://frame.work/products/laptop16"
                onChange={(e) => set({ url: e.target.value })}
              />
            </label>
          ) : (
            <>
              <div className="form-row">
                <span className="label">Tool</span>
                <Select
                  className="field"
                  label="Tool"
                  value={form.tool}
                  options={[
                    ["", "Choose…"],
                    ...readTools.map((t) => [t.name, `${t.plugin}: ${t.name}`] as const),
                    ...(form.tool && !readTools.some((t) => t.name === form.tool)
                      ? [[form.tool, form.tool] as const]
                      : []),
                  ]}
                  onChange={(tool) => set({ tool })}
                />
              </div>
              <label>
                <span className="label">Its input, as JSON</span>
                <textarea
                  className="field mono"
                  rows={3}
                  spellCheck={false}
                  value={form.input}
                  onChange={(e) => set({ input: e.target.value })}
                />
              </label>
            </>
          )}
          {form.kind === "page" && (
            <div className="form-row">
              <span className="label">Run the page's scripts</span>
              <Switch
                on={form.render}
                onChange={(render) =>
                  set({
                    render,
                    ...(render && form.pick === "path" ? { pick: "selector" as const } : {}),
                    ...(render && form.everyMinutes < MIN_RENDER_WATCH_MINUTES
                      ? { everyMinutes: MIN_RENDER_WATCH_MINUTES }
                      : {}),
                  })
                }
              />
            </div>
          )}
          <div className="form-row">
            <span className="label">Value</span>
            <Seg
              value={form.pick}
              options={(
                [
                  ["selector", "CSS selector"],
                  ["path", "JSON path"],
                  ["page", form.kind === "page" ? "Whole page" : "Whole answer"],
                ] as const
              ).filter(([pick]) => !(rendered && pick === "path"))}
              onChange={(pick) => set({ pick })}
            />
          </div>
          {form.pick === "selector" && (
            <input
              className="field mono"
              value={form.selector}
              aria-label="CSS selector"
              spellCheck={false}
              placeholder=".price"
              onChange={(e) => set({ selector: e.target.value })}
            />
          )}
          {form.pick === "path" && (
            <input
              className="field mono"
              value={form.path}
              aria-label="JSON path"
              spellCheck={false}
              placeholder="items.0.price"
              onChange={(e) => set({ path: e.target.value })}
            />
          )}
          <label>
            <span className="label">Then match, optional</span>
            <input
              className="field mono"
              value={form.pattern}
              spellCheck={false}
              placeholder="Price:\s*([\d.,]+)"
              onChange={(e) => set({ pattern: e.target.value })}
            />
          </label>
          <div className="form-actions">
            <button type="button" className="btn sm" disabled={busy || !ready} onClick={tryIt}>
              Try it
            </button>
            {preview &&
              (preview.ok ? (
                <span className="mono">{preview.value || "(empty)"}</span>
              ) : (
                <span className="form-error">{preview.error}</span>
              ))}
            {previewError && <span className="form-error">{previewError}</span>}
          </div>

          <div className="form-row">
            <span className="label">Counts when it</span>
            <Select
              className="field"
              label="Counts when it"
              value={form.when}
              options={WHEN}
              onChange={(when) => set({ when })}
            />
          </div>
          {(form.when === "contains" || form.when === "missing") && (
            <input
              className="field"
              value={form.text}
              aria-label="Text"
              placeholder="In stock"
              onChange={(e) => set({ text: e.target.value })}
            />
          )}
          {(form.when === "below" || form.when === "above") && (
            <input
              className="field"
              inputMode="decimal"
              value={form.value}
              aria-label="Number"
              placeholder="1000"
              onChange={(e) => set({ value: e.target.value })}
            />
          )}
          <div className="form-row">
            <span className="label">Look</span>
            <EverySelect
              label="Look"
              value={form.everyMinutes}
              options={every}
              onChange={(everyMinutes) => set({ everyMinutes })}
            />
          </div>
          <div className="form-row">
            <span className="label">Turn off after it counts</span>
            <Switch on={form.once} onChange={(once) => set({ once })} />
          </div>
          <label>
            <span className="label">What to do, optional</span>
            <textarea
              className="field"
              rows={4}
              maxLength={4000}
              value={form.prompt}
              placeholder="Leave empty to just be told. Or: Check whether it ships to Germany and tell me the total."
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </label>
          <BotPicker value={form.botId} onChange={(botId) => set({ botId })} />
          {stored?.tainted && (
            <TaintedNote
              taintedBy={stored.taintedBy}
              asks="tasks"
              trust={() => void trustWatcher(stored.id).catch((err) => setError(errorText(err)))}
            />
          )}
          {stored && (
            <dl className="kv">
              <dt>Now</dt>
              <dd>{stored.lastValue ?? "Not checked yet"}</dd>
              <dt>Last checked</dt>
              <dd>{stored.lastCheckedAt ? stamp(stored.lastCheckedAt) : "Never"}</dd>
              <dt>Last counted</dt>
              <dd>{stored.lastFiredAt ? stamp(stored.lastFiredAt) : "Never"}</dd>
              <dt>Next check</dt>
              <dd>{stored.enabled && stored.nextCheckAt ? stamp(stored.nextCheckAt) : "Off"}</dd>
            </dl>
          )}
          <SaveBar
            error={error}
            disabled={busy || !changed || !ready}
            onSave={save}
            label={stored ? "Save" : "Create"}
          />
        </div>

        {stored && history.error && !history.data && (
          <Panel title="Values">
            <LoadError error={history.error} retry={history.retry} />
          </Panel>
        )}
        {stored && values.length > 0 && (
          <Panel title="Values">
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {values.map((v) => (
                    <tr key={v.id}>
                      <td className="wrap">{v.value}</td>
                      <td className="muted">{v.fired ? "Counted" : ""}</td>
                      <td className="muted">{stamp(v.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
        {stored?.prompt && <Runs filter={{ watcherId: stored.id }} />}
      </div>
    </section>
  );
}
