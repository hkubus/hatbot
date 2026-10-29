import { type AppSettings, describeEvery } from "@hatbot/shared";
import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import type { PluginWeb } from "../kit";
import { PLUGIN_WEB } from "../plugins";
import { pluginAction, pluginRunning, useStore } from "../store";
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

/** Automation's own jobs, each set only here. */
export function BuiltInGroup({ toast }: { toast: Toast }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");
  const settingsVersion = useStore((s) => s.settingsVersion);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when settings change anywhere
  useEffect(() => {
    api<AppSettings>("/settings").then(setSettings, (err) => setError(errorText(err)));
  }, [settingsVersion]);

  if (!settings) return error ? <div className="form-error">{error}</div> : null;
  const update = (patch: Partial<AppSettings>) =>
    api<AppSettings>("/settings", { method: "PUT", body: patch }).then(
      (s) => {
        setSettings(s);
        toast("Saved");
      },
      (err) => toast(errorText(err, "Couldn't save."), "error"),
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
                (err) => toast(errorText(err, "Couldn't send it."), "error"),
              )
            }
          >
            Send now
          </button>
        </Row>
      )}
    </Group>
  );
}

/** What else Hatbot does on its own: in Settings, so it's there whatever is switched off. */
export function RoutinesGroup({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const plugins = useStore((s) => s.plugins);
  return (
    <Group title="Routines">
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
      {Object.entries(PLUGIN_WEB).map(([id, web]) => {
        const p = plugins[id];
        return p?.enabled && web.builtIn ? (
          <PluginRow key={id} id={id} row={web.builtIn} running={pluginRunning(p)} />
        ) : null;
      })}
    </Group>
  );
}

function PluginRow({
  id,
  row: Row,
  running,
}: {
  id: string;
  row: NonNullable<PluginWeb["builtIn"]>;
  running: boolean;
}) {
  const action = useMemo(() => pluginAction(id), [id]);
  return <Row action={action} running={running} />;
}
