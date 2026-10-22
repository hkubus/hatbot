import { describeEvery, HATBOT_ID } from "@hatbot/shared";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "./api";
import { plainText } from "./format";
import { LoadError, useLoad } from "./load";
import { loadSchedules, loadTasks, useStore } from "./store";
import { Switch } from "./switch";
import { TaskTable } from "./tasks";
import { Select } from "./ui";

/** `missing` once everything has loaded without it, or it's been deleted. */
export function useListed(
  kind: "schedules" | "triggers" | "watchers",
  id: number | null,
  stored: object | null | undefined,
) {
  const [notListed, setNotListed] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (id === null) return;
    setError("");
    loadSchedules().then(
      (ids) => setNotListed(!ids[kind].includes(id)),
      (err) => setError(errorText(err)),
    );
  }, [kind, id]);
  const have = stored !== undefined;
  useEffect(() => {
    if (!have) load();
  }, [have, load]);
  return { missing: stored === null || (notListed && !stored), error, load };
}

export function Runs({
  filter,
}: {
  filter: { scheduleId: number } | { triggerId: number } | { watcherId: number };
}) {
  const tasks = useStore((s) => s.tasks);
  const key = JSON.stringify(filter);
  const loaded = useLoad(() => loadTasks({ ...filter, view: "card" }), [key]);
  const shown = Object.values(tasks)
    .filter(
      (t) =>
        !t.parentId &&
        ("scheduleId" in filter
          ? t.scheduleId === filter.scheduleId
          : "watcherId" in filter
            ? t.watcherId === filter.watcherId
            : t.triggerId === filter.triggerId),
    )
    .sort((a, b) => b.id - a.id)
    .slice(0, 20);
  if (!loaded.data && !loaded.error) return null;
  return (
    <div className="panel">
      <h3 className="section-title">Runs</h3>
      {!loaded.data ? (
        <LoadError error={loaded.error} retry={loaded.retry} />
      ) : !shown.length ? (
        <div className="muted">Hasn't run yet.</div>
      ) : (
        <TaskTable tasks={shown} name={(t) => (t.summary ? plainText(t.summary) : t.title)} />
      )}
    </div>
  );
}

/** Only shown when there's more than one bot. */
export function BotPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const ids = useStore((s) => s.botIds);
  const bots = useStore((s) => s.bots);
  if (ids.length < 2 && value === HATBOT_ID) return null;
  return (
    <div className="form-row">
      <span className="label">Runs as</span>
      <select
        className="field"
        aria-label="Runs as"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {(ids.includes(value) ? ids : [...ids, value]).map((id) => (
          <option key={id} value={id}>
            {bots[id]?.name ?? id}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Every so many minutes, with the one set kept as a choice even when it's no longer offered. */
export function EverySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (minutes: number) => void;
}) {
  const all = (options.includes(value) ? options : [...options, value]).sort((a, b) => a - b);
  return (
    <Select
      className="field"
      label={label}
      value={value}
      options={all.map((m) => [m, describeEvery(m)] as const)}
      onChange={onChange}
    />
  );
}

export function TaintedNote({
  taintedBy,
  asks,
  trust,
}: {
  taintedBy: string | null | undefined;
  /** What asks before changing anything: "runs" or "tasks". */
  asks: string;
  trust: () => void;
}) {
  return (
    <div className="hint">
      Hatbot wrote this after reading untrusted content{taintedBy ? ` (${taintedBy})` : ""}, so its{" "}
      {asks} ask before changing anything. Check what it does, then trust it.{" "}
      <button type="button" className="btn sm" onClick={trust}>
        Trust
      </button>
    </div>
  );
}

/** Its on/off switch, saved as you flip it, apart from the form that waits for Save. */
export function OnPanel({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="panel form">
      <div className="form-row">
        <span className="label">{label}</span>
        <Switch on={on} onChange={onChange} />
      </div>
    </div>
  );
}

export const deleteText = (name: string) => `Delete "${name}"? Its past runs stay in Tasks.`;
