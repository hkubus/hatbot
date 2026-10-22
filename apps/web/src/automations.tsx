import { HATBOT_ID } from "@hatbot/shared";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "./api";
import { plainText, stamp } from "./format";
import { Link } from "./link";
import { LoadError, useLoad } from "./load";
import { loadSchedules, loadTasks, useStore } from "./store";
import { StatusChip } from "./tasks";

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
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {shown.map((t) => (
                <tr key={t.id} className="link-row">
                  <td className="wrap">
                    <Link to={`/tasks/${t.id}`}>{t.summary ? plainText(t.summary) : t.title}</Link>
                  </td>
                  <td>
                    <StatusChip status={t.status} />
                  </td>
                  <td className="muted">{stamp(t.startedAt ?? t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
