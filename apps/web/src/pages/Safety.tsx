import type { ApprovalLevel, AppSettings, SafetyKind, SafetySettings } from "@hatbot/shared";
import { api, errorText } from "../api";
import { ask } from "../confirm";
import { PageLoad, useLoad } from "../load";
import { SavedRow } from "../saved-row";
import { useStore } from "../store";
import { Switch } from "../switch";
import type { Toast } from "../toast";
import { BackHead, Group, Row, Select } from "../ui";

export type SafetyPatch = Partial<Omit<SafetySettings, "kinds">> & {
  kinds?: Partial<SafetySettings["kinds"]>;
};

const KINDS: readonly (readonly [SafetyKind, string])[] = [
  ["send", "Sending messages"],
  ["submit_personal_data", "Giving out your details"],
  ["delete", "Deleting"],
  ["other", "Other changes"],
  ["purchase", "Buying"],
  ["payment", "Paying"],
  ["account_security", "Accounts, passwords and keys"],
  ["access", "Doors, locks and the alarm"],
  ["computer", "Using your computers"],
];
const LEVELS: readonly (readonly [ApprovalLevel, string])[] = [
  ["ask", "Ask me"],
  ["review", "Review first"],
  ["allow", "Don't ask"],
];
const RISKY: SafetyKind[] = ["purchase", "payment", "account_security", "access", "computer"];

export const TOOL_LEVELS = [
  ["plugin", "As the plugin says"],
  ["ask", "Always ask"],
  ["allow", "Never ask"],
] as const;

/** Rejects with the brain's message. */
export const saveSafety = (safety: SafetyPatch) =>
  api<AppSettings>("/settings", { method: "PUT", body: { safety } });

export function SafetyPage({ toast }: { toast: Toast }) {
  const settingsVersion = useStore((s) => s.settingsVersion);
  const {
    data: settings,
    setData: setSettings,
    ...load
  } = useLoad(() => api<AppSettings>("/settings"), [settingsVersion]);
  if (!settings) return <PageLoad error={load.error} retry={load.retry} />;
  const { safety } = settings;

  const put = async (patch: SafetyPatch | { reviewChanges: boolean }) => {
    const body = "reviewChanges" in patch ? patch : { safety: patch };
    setSettings(await api<AppSettings>("/settings", { method: "PUT", body }));
    toast("Saved");
  };
  const update = (patch: SafetyPatch | { reviewChanges: boolean }) =>
    put(patch).catch((err) => toast(errorText(err, "Couldn't save."), "error"));

  const setKind = async (kind: SafetyKind, label: string, level: ApprovalLevel) => {
    if (
      level === "allow" &&
      RISKY.includes(kind) &&
      !(await ask({
        text: `${label} will go ahead without asking you, even after reading pages and messages strangers wrote.`,
        ok: "Don't ask",
      }))
    )
      return;
    await update({ kinds: { [kind]: level } });
  };
  const setRule = async (key: "untrusted" | "injection", on: boolean) => {
    if (
      !on &&
      !(await ask({
        text:
          key === "untrusted"
            ? "Changes will go ahead after reading pages, messages and output strangers wrote, which may hold instructions aimed at Hatbot."
            : "Work will carry on after reading something that looks like instructions aimed at Hatbot.",
        ok: "Turn off",
      }))
    )
      return;
    await update({ [key]: on });
  };
  const tools = Object.entries(safety.tools).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings" />

        <Group title="Approvals">
          {KINDS.map(([kind, label]) => (
            <Row key={kind} label={label}>
              <Select
                label={label}
                value={safety.kinds[kind]}
                options={LEVELS}
                onChange={(level) => setKind(kind, label, level)}
              />
            </Row>
          ))}
        </Group>

        <Group title="Guardrails">
          <Row label="Let a safety review allow safe changes without asking you">
            <Switch
              on={settings.reviewChanges}
              onChange={(reviewChanges) => update({ reviewChanges })}
            />
          </Row>
          <Row label="Ask before changes after reading untrusted content">
            <Switch on={safety.untrusted} onChange={(on) => setRule("untrusted", on)} />
          </Row>
          <Row label="Ask about every change once something read looks like instructions aimed at Hatbot">
            <Switch on={safety.injection} onChange={(on) => setRule("injection", on)} />
          </Row>
          <SavedRow<number>
            label="Commands one chat reply may run"
            saved={safety.chatCommands}
            parse={(text) => {
              const n = Number(text.trim());
              return Number.isInteger(n) && n >= 1 && n <= 50
                ? { value: n }
                : { error: "A whole number from 1 to 50." };
            }}
            save={(chatCommands) => put({ chatCommands })}
            input={{ type: "number", min: 1, max: 50, step: 1 }}
          />
        </Group>

        <Group title="Tools" empty={!tools.length && "None. Set them on each plugin's page."}>
          {tools.map(([name, level]) => (
            <Row key={name} label={<span className="mono">{name}</span>}>
              <span className="val">{level === "ask" ? "Always ask" : "Never ask"}</span>
              <button
                type="button"
                className="btn sm danger-text"
                onClick={() =>
                  update({ tools: Object.fromEntries(tools.filter(([n]) => n !== name)) })
                }
              >
                Remove
              </button>
            </Row>
          ))}
        </Group>
      </div>
    </section>
  );
}
