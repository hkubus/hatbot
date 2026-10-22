import { type AppSettings, describeEvery } from "@hatbot/shared";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { CodeSuggestions } from "../plugins/self";
import { loadPlugins, useStore } from "../store";
import { Switch } from "../switch";
import type { Toast } from "../toast";
import { Group, LinkRow, Row, Select } from "../ui";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function HourSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (hour: number) => void;
}) {
  return (
    <Select
      label={label}
      value={value}
      options={HOURS.map((h) => [h, `${String(h).padStart(2, "0")}:00`] as const)}
      onChange={onChange}
    />
  );
}

/** The jobs Hatbot runs on its own, each set only here. */
export function BuiltInGroup({ toast }: { toast: Toast }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");
  const settingsVersion = useStore((s) => s.settingsVersion);
  const self = useStore((s) => s.plugins.self);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when settings change anywhere
  useEffect(() => {
    api<AppSettings>("/settings").then(setSettings, (err) => setError(errorText(err)));
  }, [settingsVersion]);
  useEffect(() => {
    void loadPlugins().catch(() => {});
  }, []);
  const selfAction = useCallback(
    async <T,>(name: string, args: unknown = {}) =>
      (await api<{ result: T }>(`/plugins/self/actions/${name}`, { body: args })).result,
    [],
  );

  if (!settings) return error ? <div className="form-error">{error}</div> : null;
  const update = (patch: Partial<AppSettings>) =>
    api<AppSettings>("/settings", { method: "PUT", body: patch }).then(
      (s) => {
        setSettings(s);
        toast("Saved");
      },
      (err) => toast(errorText(err, "Couldn't save"), "error"),
    );
  const report = settings.weeklyReport;

  return (
    <Group title="Built in">
      <LinkRow to="/schedules/heartbeat" label="Heartbeat">
        <span className="val">
          {settings.heartbeat.enabled ? describeEvery(settings.heartbeat.everyMinutes) : "Off"}
        </span>
      </LinkRow>
      <Row label="Weekly report">
        <Switch
          on={report.enabled}
          onChange={(enabled) => update({ weeklyReport: { ...report, enabled } })}
        />
      </Row>
      {report.enabled && (
        <Row label="Sent on">
          <Select
            label="Sent on"
            value={report.weekday}
            options={WEEKDAYS.map((d, i) => [i, d] as const)}
            onChange={(weekday) => update({ weeklyReport: { ...report, weekday } })}
          />
          <HourSelect
            label="Sent at"
            value={report.hour}
            onChange={(hour) => update({ weeklyReport: { ...report, hour } })}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              api("/report/send", { body: {} }).then(
                () => toast("Sent to Hatbot's chat"),
                () => toast("Couldn't send", "error"),
              )
            }
          >
            Send now
          </button>
        </Row>
      )}
      <Row label="To-do reminder each morning at">
        <HourSelect
          label="To-do reminder each morning at"
          value={settings.todoHour}
          onChange={(todoHour) => update({ todoHour })}
        />
      </Row>
      <Row label="Propose a memory tidy-up weekly">
        <Switch on={settings.memoryTidy} onChange={(memoryTidy) => update({ memoryTidy })} />
      </Row>
      {self && (
        <CodeSuggestions
          action={selfAction}
          running={self.state === "ready" || self.state === "needs_setup"}
        />
      )}
    </Group>
  );
}
