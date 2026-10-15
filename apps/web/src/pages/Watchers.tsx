// Watchers: a page or a plugin's value, looked at on a timer without the model.
import {
  describeEvery,
  HATBOT_ID,
  type WatchCondition,
  type Watcher,
  type WatcherValue,
  type WatchPreview,
  type WatchSource,
} from "@hatbot/shared";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import { navigate } from "../router";
import { loadPlugins, loadSchedules, putWatcher, useStore } from "../store";
import { Switch } from "../switch";
import { BotPicker, errorText, Runs, stamp } from "./Schedules";

const EVERY = [5, 15, 30, 60, 180, 360, 720, 1440];
const WHEN: { when: WatchCondition["when"]; label: string }[] = [
  { when: "changed", label: "Changes" },
  { when: "contains", label: "Contains" },
  { when: "missing", label: "Doesn't contain" },
  { when: "below", label: "Below" },
  { when: "above", label: "Above" },
];
type Pick = "page" | "selector" | "path";

const patchWatcher = (id: number, body: object) =>
  api<Watcher>(`/watchers/${id}`, { method: "PATCH", body }).then(putWatcher);

/** The Watchers group on the Schedules page. */
export function WatcherList({ onError }: { onError: (error: string) => void }) {
  const watchers = useStore((s) => s.watchers);
  const shown = Object.values(watchers)
    .filter((w): w is Watcher => Boolean(w))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="group">
      <h2>Watchers</h2>
      <div className="group-box">
        {shown.map((w) => (
          <div className="row" key={w.id}>
            <button
              type="button"
              className="row-main"
              onClick={() => navigate(`/watchers/${w.id}`)}
            >
              <div className="txt">
                <b>{w.name}</b>
              </div>
              {w.lastError ? (
                <span className="val">Can't read</span>
              ) : (
                <span className="val">{w.enabled ? (w.lastValue ?? "") : "Off"}</span>
              )}
            </button>
            <Switch
              on={w.enabled}
              onChange={(enabled) =>
                patchWatcher(w.id, { enabled }).catch((err) => onError(errorText(err)))
              }
            />
            <Icon name="chevron" className="chev" />
          </div>
        ))}
        {!shown.length && (
          <div className="row">
            <span className="muted">None yet. Ask Hatbot to tell you when something changes.</span>
          </div>
        )}
      </div>
    </section>
  );
}

type Form = {
  name: string;
  kind: WatchSource["kind"];
  url: string;
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

const blank: Form = {
  name: "",
  kind: "page",
  url: "",
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

/** The form as the API takes it, or what's wrong with it. */
function bodyOf(f: Form): { source: WatchSource; condition: WatchCondition } | string {
  let input: Record<string, unknown> = {};
  if (f.kind === "tool") {
    try {
      input = JSON.parse(f.input || "{}");
    } catch {
      return "The tool's input isn't JSON.";
    }
  }
  const source: WatchSource = {
    kind: f.kind,
    ...(f.kind === "page" ? { url: f.url.trim() } : { tool: f.tool, input }),
    ...(f.pick === "selector" && f.selector.trim() ? { selector: f.selector.trim() } : {}),
    ...(f.pick === "path" && f.path.trim() ? { path: f.path.trim() } : {}),
    ...(f.pattern ? { pattern: f.pattern } : {}),
  };
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

export function WatcherEdit({ id }: { id: number | null }) {
  const stored = useStore((s) => (id === null ? undefined : s.watchers[id]));
  const plugins = useStore((s) => s.plugins);
  const [form, setForm] = useState<Form | null>(id === null ? blank : null);
  const [preview, setPreview] = useState<WatchPreview | null>(null);
  const [values, setValues] = useState<WatcherValue[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id !== null && stored === undefined)
      loadSchedules().catch((err) => setError(errorText(err)));
  }, [id, stored]);
  useEffect(() => {
    if (stored && !form) setForm(formOf(stored));
  }, [stored, form]);
  useEffect(() => {
    void loadPlugins().catch(() => {});
  }, []);
  // Its history, again when a check finds something new.
  const lastValue = stored?.lastValue;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetched when the value changes
  useEffect(() => {
    if (id !== null)
      api<WatcherValue[]>(`/watchers/${id}/values?limit=50`).then(setValues, () => setValues([]));
  }, [id, lastValue]);

  if (stored === null) return <div className="empty">This watcher doesn't exist.</div>;
  if (!form) return <section className="view" />;

  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setPreview(null);
  };
  const readTools = Object.values(plugins)
    .filter((p) => p.enabled && p.state === "ready")
    .flatMap((p) =>
      p.tools.filter((t) => t.access === "read").map((t) => ({ ...t, plugin: p.name })),
    );
  const body = bodyOf(form);
  const fields = {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    everyMinutes: form.everyMinutes,
    once: form.once,
    botId: form.botId,
  };
  const changed =
    !stored ||
    stored.tainted ||
    typeof body === "string" ||
    JSON.stringify({ ...fields, ...body }) !==
      JSON.stringify({
        name: stored.name,
        prompt: stored.prompt,
        everyMinutes: stored.everyMinutes,
        once: stored.once,
        botId: stored.botId,
        source: stored.source,
        condition: stored.condition,
      });
  const ready =
    Boolean(fields.name) && (form.kind === "page" ? Boolean(form.url.trim()) : Boolean(form.tool));

  const tryIt = async () => {
    if (typeof body === "string") return setError(body);
    setError("");
    setBusy(true);
    try {
      setPreview(
        await api<WatchPreview>("/watchers/preview", {
          body: { source: body.source, botId: form.botId },
        }),
      );
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };
  const save = async () => {
    if (typeof body === "string") return setError(body);
    setBusy(true);
    setError("");
    try {
      if (stored) {
        await patchWatcher(stored.id, { ...fields, ...body });
      } else {
        const w = await api<Watcher>("/watchers", { body: { ...fields, ...body } });
        putWatcher(w);
        navigate(`/watchers/${w.id}`, true);
      }
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };
  const checkNow = async () => {
    if (!stored) return;
    try {
      putWatcher(await api<Watcher>(`/watchers/${stored.id}/check`, { body: {} }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const remove = async () => {
    if (!stored || !confirm(`Delete "${stored.name}"? The tasks it started stay in Tasks.`)) return;
    try {
      await api(`/watchers/${stored.id}`, { method: "DELETE" });
      navigate("/schedules");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button
            type="button"
            className="btn sm ghost back"
            onClick={() => navigate("/schedules")}
          >
            <Icon name="chevron" />
            Watchers
          </button>
          <span className="spacer" />
          {stored && (
            <>
              <button type="button" className="btn sm" onClick={checkNow}>
                Check now
              </button>
              <button type="button" className="btn sm danger-text" onClick={remove}>
                Delete
              </button>
            </>
          )}
        </div>

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
            <div className="seg">
              <button
                type="button"
                className={form.kind === "page" ? "active" : ""}
                onClick={() => set({ kind: "page" })}
              >
                A page
              </button>
              <button
                type="button"
                className={form.kind === "tool" ? "active" : ""}
                onClick={() =>
                  set({ kind: "tool", pick: form.pick === "selector" ? "path" : form.pick })
                }
              >
                A plugin
              </button>
            </div>
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
              <span className="muted hint">
                Fetched from the desktop as plain HTML. A page that only fills in with JavaScript
                needs a schedule instead.
              </span>
            </label>
          ) : (
            <>
              <label>
                <span className="label">Tool</span>
                <select
                  className="field"
                  value={form.tool}
                  onChange={(e) => set({ tool: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {readTools.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.plugin}: {t.name}
                    </option>
                  ))}
                  {form.tool && !readTools.some((t) => t.name === form.tool) && (
                    <option value={form.tool}>{form.tool}</option>
                  )}
                </select>
              </label>
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
          <div className="form-row">
            <span className="label">Value</span>
            <div className="seg">
              {(
                [
                  ["selector", "CSS selector"],
                  ["path", "JSON path"],
                  ["page", form.kind === "page" ? "Whole page" : "Whole answer"],
                ] as const
              ).map(([pick, label]) => (
                <button
                  type="button"
                  key={pick}
                  className={form.pick === pick ? "active" : ""}
                  onClick={() => set({ pick })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {form.pick === "selector" && (
            <input
              className="field mono"
              value={form.selector}
              spellCheck={false}
              placeholder=".price"
              onChange={(e) => set({ selector: e.target.value })}
            />
          )}
          {form.pick === "path" && (
            <input
              className="field mono"
              value={form.path}
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
          </div>

          <div className="form-row">
            <span className="label">Counts when it</span>
            <select
              className="field"
              value={form.when}
              onChange={(e) => set({ when: e.target.value as WatchCondition["when"] })}
            >
              {WHEN.map((w) => (
                <option key={w.when} value={w.when}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          {(form.when === "contains" || form.when === "missing") && (
            <input
              className="field"
              value={form.text}
              placeholder="In stock"
              onChange={(e) => set({ text: e.target.value })}
            />
          )}
          {(form.when === "below" || form.when === "above") && (
            <input
              className="field"
              inputMode="decimal"
              value={form.value}
              placeholder="1000"
              onChange={(e) => set({ value: e.target.value })}
            />
          )}
          <div className="form-row">
            <span className="label">Look</span>
            <select
              className="field"
              value={form.everyMinutes}
              onChange={(e) => set({ everyMinutes: Number(e.target.value) })}
            >
              {(EVERY.includes(form.everyMinutes) ? EVERY : [...EVERY, form.everyMinutes])
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {describeEvery(m)}
                  </option>
                ))}
            </select>
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
            <div className="hint">
              Hatbot wrote this after reading untrusted content
              {stored.taintedBy ? ` (${stored.taintedBy})` : ""}, so its tasks ask before changing
              anything. Check what it does and save to trust it.
            </div>
          )}
          {stored && (
            <dl className="kv">
              <dt>Now</dt>
              <dd>{stored.lastValue ?? "Not checked yet"}</dd>
              {stored.lastError && (
                <>
                  <dt>Can't read</dt>
                  <dd>
                    {stored.lastError} ({stored.errors} in a row)
                  </dd>
                </>
              )}
              <dt>Last checked</dt>
              <dd>{stored.lastCheckedAt ? stamp(stored.lastCheckedAt) : "Never"}</dd>
              <dt>Last counted</dt>
              <dd>{stored.lastFiredAt ? stamp(stored.lastFiredAt) : "Never"}</dd>
              <dt>Next check</dt>
              <dd>{stored.enabled && stored.nextCheckAt ? stamp(stored.nextCheckAt) : "Off"}</dd>
            </dl>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button
              type="button"
              className="btn accent"
              disabled={busy || !changed || !ready}
              onClick={save}
            >
              {stored ? "Save" : "Create"}
            </button>
          </div>
        </div>

        {stored && values.length > 0 && (
          <div className="panel">
            <h3 className="section-title">Values</h3>
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
          </div>
        )}
        {stored?.prompt && <Runs filter={{ watcherId: stored.id }} />}
      </div>
    </section>
  );
}
