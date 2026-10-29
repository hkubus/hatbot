// One schedule, which the brain makes, changes or deletes; off by default. Set in Automations.
import { describeCron } from "@hatbot/shared";
import {
  Group,
  LinkRow,
  type PluginSettingsProps,
  type PluginWeb,
  Row,
  Seg,
  useAction,
} from "@hatbot/web/kit";
import { useEffect, useState } from "react";

type Every = "off" | "weekly" | "monthly";
type Suggestions = { every: Every | "other"; cron?: string };

const OPTIONS = [
  ["off", "Off"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
] as const;

export function SelfSettings() {
  return (
    <Group title="Schedule">
      <LinkRow to="/schedules" label="Code improvement suggestions" />
    </Group>
  );
}

export function CodeSuggestions({
  action,
  running,
}: Pick<PluginSettingsProps, "action" | "running">) {
  const [now, setNow] = useState<Suggestions | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!running) return;
    // Only a plugin that's set up answers; until then there's nothing to show.
    action<Suggestions>("suggestions").then(setNow, () => {});
  }, [action, running]);

  if (!now) return null;
  const choose = (every: Every | "other") => {
    if (every === "other" || every === now.every || busy) return;
    void run(async () => setNow(await action<Suggestions>("suggest", { every })));
  };
  const options =
    now.every === "other" && now.cron
      ? [...OPTIONS, ["other", describeCron(now.cron)] as const]
      : OPTIONS;

  return (
    <Row
      label="Code improvement suggestions"
      sub={error && <span className="form-error">{error}</span>}
    >
      <Seg<Every | "other"> value={now.every} options={options} onChange={choose} />
    </Row>
  );
}

export const web: PluginWeb = { settings: SelfSettings, builtIn: CodeSuggestions };
