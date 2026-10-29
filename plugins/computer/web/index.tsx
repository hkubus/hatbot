import type { ComputerInfo } from "@hatbot/shared";
import {
  ask,
  askText,
  Copyable,
  errorText,
  Panel,
  type PluginSettingsProps,
  type PluginWeb,
  Switch,
  useAction,
} from "@hatbot/web/kit";
import { useEffect, useState } from "react";

// niri's rules match app ids as regular expressions, so each line covers its packagings too.
const NIRI_RULE = `window-rule {
    match app-id="KeePassXC"
    match app-id="Bitwarden"
    match app-id="1Password"
    match app-id="(?i)signal"
    block-out-from "screen-capture"
}`;

const stateOf = (c: ComputerInfo) =>
  !c.online
    ? "Offline"
    : !c.enabled
      ? "Off: switch it on in Hatbot's app there"
      : c.paused
        ? "Paused"
        : c.locked
          ? "Locked"
          : "Online";

export function ComputerSettings({ action, running }: PluginSettingsProps) {
  const [computers, setComputers] = useState<ComputerInfo[] | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!running) return;
    action<ComputerInfo[]>("list").then(setComputers, (err) => setError(errorText(err)));
  }, [action, running, setError]);

  const act = (name: string, args: Record<string, unknown>) =>
    run(async () => setComputers(await action<ComputerInfo[]>(name, args)));
  const rename = async (c: ComputerInfo) => {
    const name = await askText({ text: `Rename ${c.name}`, placeholder: c.name, ok: "Rename" });
    if (name?.trim()) await act("rename", { id: c.id, name: name.trim() });
  };
  const turnOff = async (c: ComputerInfo) => {
    if (
      await ask({
        text: `Turn off Hatbot's use of ${c.name}? Only the computer can turn it on again.`,
        ok: "Turn off",
      })
    )
      await act("turnOff", { id: c.id });
  };
  const forget = async (c: ComputerInfo) => {
    if (
      await ask({
        text: `Forget ${c.name}? If its app is still signed in, it comes back as new.`,
        ok: "Forget",
      })
    )
      await act("forget", { id: c.id });
  };

  return (
    <>
      <Panel title="Computers" className="form">
        {computers?.length === 0 && (
          <span className="label">
            None yet. Install Hatbot's Linux app on a computer, sign in, and switch on "Let Hatbot
            use this computer" there.
          </span>
        )}
        {computers?.map((c) => (
          <div className="host-edit" key={c.id}>
            <div className="form-row">
              <b>{c.name}</b>
              <span className="label">{stateOf(c)}</span>
            </div>
            <div className="form-row">
              <span className="label">Ask before every command and file outside Downloads</span>
              <Switch
                on={c.careful}
                onChange={(careful) => act("careful", { id: c.id, careful })}
              />
            </div>
            <div className="form-row">
              <span className="host-actions">
                <button type="button" className="btn sm" disabled={busy} onClick={() => rename(c)}>
                  Rename
                </button>
                {c.online && c.enabled && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => act("pause", { id: c.id, paused: !c.paused })}
                  >
                    {c.paused ? "Resume" : "Pause"}
                  </button>
                )}
                {c.online && c.enabled && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => turnOff(c)}
                  >
                    Turn off
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm danger-text"
                  disabled={busy}
                  onClick={() => forget(c)}
                >
                  Forget
                </button>
              </span>
            </div>
          </div>
        ))}
        {error && <div className="form-error">{error}</div>}
      </Panel>
      <Panel title="Keep password managers out of sight" className="form">
        <span className="label">
          On niri, add this to ~/.config/niri/config.kdl. Their windows are blacked out of every
          screenshot and of Live, and Hatbot never types into them.
        </span>
        <Copyable value={NIRI_RULE} className="pre" />
      </Panel>
    </>
  );
}

export const web: PluginWeb = { settings: ComputerSettings };
