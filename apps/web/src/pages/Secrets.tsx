// What you keep for the bots to put in files by name. They never see a value; only you do, here.
import { type KeptSecret, SECRET_NAME } from "@hatbot/shared";
import { type FormEvent, Fragment, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { Copyable } from "../copy";
import { day } from "../format";
import { LoadError, useLoad } from "../load";
import type { Toast } from "../toast";
import { BackHead, Group, Row } from "../ui";

export function SecretsPage({ toast }: { toast: Toast }) {
  const {
    data: kept,
    setData: setKept,
    error,
    retry,
  } = useLoad(() => api<KeptSecret[]>("/secrets"), []);
  const [shown, setShown] = useState<Record<string, string>>({});

  const show = async (name: string) => {
    if (name in shown) {
      const { [name]: _, ...rest } = shown;
      setShown(rest);
      return;
    }
    try {
      const r = await api<{ value: string }>(`/secrets/${name}/show`, { body: {} });
      setShown({ ...shown, [name]: r.value });
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const remove = async (name: string) => {
    if (!(await ask({ text: `Delete ${name}? Files it's in keep it.`, ok: "Delete" }))) return;
    try {
      await api(`/secrets/${name}`, { method: "DELETE" });
      setKept(await api<KeptSecret[]>("/secrets"));
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings" />
        {error && <LoadError error={error} retry={retry} />}
        {kept && (
          <>
            <Group title="Secrets" empty={kept.length ? undefined : "None yet"}>
              {kept.map((s) => (
                <Fragment key={s.name}>
                  <Row label={<span className="mono">{s.name}</span>}>
                    <span className="val">Set {day(s.setAt)}</span>
                    <button type="button" className="btn sm" onClick={() => show(s.name)}>
                      {s.name in shown ? "Hide" : "Show"}
                    </button>
                    <button
                      type="button"
                      className="btn sm danger-text"
                      onClick={() => remove(s.name)}
                    >
                      Delete
                    </button>
                  </Row>
                  {shown[s.name] !== undefined && (
                    <div className="row token-new">
                      <Copyable value={shown[s.name] as string} />
                    </div>
                  )}
                </Fragment>
              ))}
            </Group>
            <SecretForm
              onSaved={async () => {
                setKept(await api<KeptSecret[]>("/secrets"));
                setShown({});
                toast("Saved");
              }}
            />
          </>
        )}
      </div>
    </section>
  );
}

function SecretForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const { busy, error, setError, run } = useAction();
  useLeaveGuard(value !== "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!SECRET_NAME.test(n))
      return setError("A name in capitals, digits and underscores, like GITEA_TOKEN.");
    run(async () => {
      await api(`/secrets/${n}`, { method: "PUT", body: { value } });
      setName("");
      setValue("");
      await onSaved();
    });
  };

  return (
    <form className="panel form" onSubmit={submit}>
      <h3 className="section-title">Add or replace a secret</h3>
      <div className="muted">The bots put it in files as {"{{secret:NAME}}"} and never see it.</div>
      <label>
        <span className="label">Name</span>
        <input
          className="field mono"
          autoComplete="off"
          spellCheck={false}
          placeholder="GITEA_TOKEN"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
        />
      </label>
      <label>
        <span className="label">Value</span>
        <input
          className="field mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="submit" className="btn accent" disabled={busy || !name.trim() || !value}>
          Save
        </button>
      </div>
    </form>
  );
}
