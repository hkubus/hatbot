// One schedule, which the brain makes, changes or deletes; off by default.
import { describeCron } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { useAction } from "../action";
import { Seg } from "../ui";
import type { PluginSettingsProps } from ".";

type Every = "off" | "weekly" | "monthly";
type Suggestions = { every: Every | "other"; cron?: string };

const OPTIONS = [
  ["off", "Off"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
] as const;

export function SelfSettings({ action, running }: PluginSettingsProps) {
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
    <div className="panel form">
      <span className="label">Suggest an improvement to its code, as a pull request</span>
      <Seg<Every | "other"> value={now.every} options={options} onChange={choose} />
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
