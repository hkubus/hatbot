import { describeSteps, type Script, type Task } from "@hatbot/shared";
import { useState } from "react";
import { useAction } from "../action";
import { api } from "../api";
import { BotPicker, deleteText, OnPanel, Runs, useListed } from "../automations";
import { ask, useLeaveGuard } from "../confirm";
import { useStoredForm } from "../form";
import { stamp } from "../format";
import { Icon } from "../icons";
import { PageLoad } from "../load";
import { navigate } from "../router";
import { putScript, useStore } from "../store";
import type { Toast } from "../toast";
import { BackHead, Panel, SaveBar } from "../ui";

const json = (v: unknown) => JSON.stringify(v, null, 2);

const formOf = (s: Script) => ({
  name: s.name,
  description: s.description,
  inputs: json(s.inputs),
  steps: json(s.steps),
  botId: s.botId,
});

export const patchScript = async (id: number, body: object) => {
  const s = await api<Script>(`/scripts/${id}`, { method: "PATCH", body });
  putScript(s);
  return s;
};

/** A value you type for an input: JSON where it reads as JSON, text otherwise. */
function typed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function ScriptEdit({ id, toast }: { id: number; toast: Toast }) {
  const stored = useStore((s) => s.scripts[id]);
  const running = useStore((s) =>
    Object.values(s.tasks).some((t) => t.scriptId === id && !t.parentId && !t.finishedAt),
  );
  const { form, dirty, set, saved } = useStoredForm(stored ? formOf(stored) : undefined);
  const [input, setInput] = useState<Record<string, string>>({});
  const { busy, error, setError, run } = useAction();
  const acting = useAction();
  const starting = useAction();
  const listed = useListed("scripts", id, stored);
  const edited = dirty && stored !== null;
  const release = useLeaveGuard(edited);

  if (listed.missing || !form || !stored)
    return (
      <PageLoad
        error={listed.error}
        missing={listed.missing ? "This script doesn't exist." : ""}
        retry={listed.load}
        back={{ label: "Automations", to: "/schedules" }}
      />
    );

  // Saving it as it is approves it, and makes it yours.
  const unapproved = stored.writes.length > 0 && !stored.approved;
  const changed = edited || stored.tainted || unapproved;

  const save = () =>
    run(async () => {
      let inputs: unknown;
      let steps: unknown;
      try {
        inputs = JSON.parse(form.inputs || "[]");
        steps = JSON.parse(form.steps);
      } catch {
        setError("The inputs or the steps aren't JSON.");
        return;
      }
      const s = await patchScript(stored.id, {
        name: form.name.trim(),
        description: form.description.trim(),
        botId: form.botId,
        inputs,
        steps,
      });
      saved(form, formOf(s));
      toast("Saved");
    });
  const remove = async () => {
    if (!(await ask({ text: deleteText(stored.name), ok: "Delete" }))) return;
    await acting.run(async () => {
      await api(`/scripts/${stored.id}`, { method: "DELETE" });
      release();
      navigate("/schedules");
    });
  };
  const runNow = () =>
    starting.run(async () => {
      const given = Object.fromEntries(
        stored.inputs.map((i) => [i.name, typed(input[i.name] ?? "")]),
      );
      const task = await api<Task>(`/scripts/${stored.id}/run`, { body: { input: given } });
      navigate(`/tasks/${task.id}`);
    });

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/schedules" label="Automations">
          <button
            type="button"
            className="btn sm"
            disabled={edited || running || starting.busy || !stored.enabled}
            title={
              edited
                ? "Save your changes first"
                : running
                  ? "It's running"
                  : !stored.enabled
                    ? "It's off"
                    : undefined
            }
            onClick={runNow}
          >
            <Icon name="play" />
            {starting.busy ? "Starting…" : "Run now"}
          </button>
          <button type="button" className="btn sm danger-text" onClick={remove}>
            Delete
          </button>
        </BackHead>
        {(starting.error || acting.error) && (
          <div className="form-error">{starting.error || acting.error}</div>
        )}
        <OnPanel
          label="Script"
          on={stored.enabled}
          onChange={(enabled) =>
            acting.run(async () => {
              await patchScript(stored.id, { enabled });
              toast("Saved");
            })
          }
        />

        {stored.inputs.length > 0 && (
          <div className="panel form">
            {stored.inputs.map((i) => (
              <label key={i.name}>
                <span className="label">{i.name}</span>
                <input
                  className="field"
                  value={input[i.name] ?? ""}
                  placeholder={i.description}
                  onChange={(e) => setInput({ ...input, [i.name]: e.target.value })}
                />
              </label>
            ))}
          </div>
        )}

        <Panel title="What it does">
          <pre className="script-steps">{describeSteps(stored.steps).join("\n")}</pre>
          {unapproved && (
            <div className="hint">
              It changes things with {stored.writes.join(", ")}, and you haven't approved it as it
              is, so it doesn't run. Check what it does, then save it.
            </div>
          )}
          {stored.tainted && (
            <div className="hint">
              Hatbot wrote this after reading untrusted content
              {stored.taintedBy ? ` (${stored.taintedBy})` : ""}, so its runs start tainted. Check
              what it does, then save it.
            </div>
          )}
        </Panel>

        <div className="panel form">
          <label>
            <span className="label">Name</span>
            <input
              className="field mono"
              value={form.name}
              maxLength={48}
              spellCheck={false}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label>
            <span className="label">What it's for</span>
            <input
              className="field"
              value={form.description}
              maxLength={500}
              onChange={(e) => set({ description: e.target.value })}
            />
          </label>
          <label>
            <span className="label">Inputs</span>
            <textarea
              className="field mono"
              rows={3}
              spellCheck={false}
              value={form.inputs}
              onChange={(e) => set({ inputs: e.target.value })}
            />
          </label>
          <label>
            <span className="label">Steps</span>
            <textarea
              className="field mono"
              rows={14}
              spellCheck={false}
              value={form.steps}
              onChange={(e) => set({ steps: e.target.value })}
            />
          </label>
          <BotPicker value={form.botId} onChange={(botId) => set({ botId })} />
          <dl className="kv">
            <dt>Last run</dt>
            <dd>{stored.lastRunAt ? stamp(stored.lastRunAt) : "Never"}</dd>
          </dl>
          <SaveBar
            error={error}
            disabled={busy || !changed || !form.name.trim() || !form.description.trim()}
            onSave={save}
          />
        </div>

        <Runs filter={{ scriptId: stored.id }} />
      </div>
    </section>
  );
}
