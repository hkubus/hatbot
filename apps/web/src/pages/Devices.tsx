import type { ApiToken, CreateTokenResponse, Session, SignedOutOthers } from "@hatbot/shared";
import { useState } from "react";
import { useAction } from "../action";
import { ApiError, api, errorText } from "../api";
import { ask, askText } from "../confirm";
import { deviceName } from "../device";
import { day } from "../format";
import { LoadError, useLoad } from "../load";
import type { Toast } from "../toast";
import { BackHead, Group, Row } from "../ui";

const since = (iso: string) => `Since ${day(iso)}`;

/** One signed out already, from another tab or by expiring, is no error. */
export async function signOut(id: number): Promise<string | null> {
  try {
    await api(`/auth/sessions/${id}`, { method: "DELETE" });
    return null;
  } catch (err) {
    return err instanceof ApiError && err.status === 404 ? null : errorText(err);
  }
}

export function Devices({ toast }: { toast: Toast }) {
  const [newToken, setNewToken] = useState<CreateTokenResponse | null>(null);
  const tokenEdit = useAction();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const loaded = useLoad(
    () =>
      Promise.all([api<Session[]>("/auth/sessions"), api<ApiToken[]>("/tokens")]).then(([s, t]) => {
        setTokens(t);
        return s;
      }),
    [],
  );
  const sessions = loaded.data;
  const load = loaded.retry;

  const end = async (s: Session) => {
    const error = await signOut(s.id);
    if (error) toast(error, "error");
    load();
  };

  const endOthers = async () => {
    if (
      !(await ask({
        text: "Sign out every other browser and app? Apps will need to sign in again.",
        ok: "Sign out",
      }))
    )
      return;
    try {
      const r = await api<SignedOutOthers>("/auth/sign-out-others", { body: {} });
      if (r.ended) toast("Signed out everywhere else");
      else toast("Nowhere else was signed in", "info");
    } catch (err) {
      toast(errorText(err), "error");
    }
    load();
  };

  const createToken = async () => {
    const name = await askText({
      text: "Name for the new token",
      placeholder: "iPhone",
      ok: "Create",
    });
    if (!name) return;
    await tokenEdit.run(async () => {
      setNewToken(await api<CreateTokenResponse>("/tokens", { body: { name } }));
      setTokens(await api<ApiToken[]>("/tokens"));
    });
  };

  const revoke = async (t: ApiToken) => {
    if (
      !(await ask({ text: `Revoke "${t.name}"? Apps using it will be signed out.`, ok: "Revoke" }))
    )
      return;
    await tokenEdit.run(async () => {
      await api(`/tokens/${t.id}`, { method: "DELETE" });
      setTokens(await api<ApiToken[]>("/tokens"));
    });
  };

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings" />
        {loaded.error && <LoadError error={loaded.error} retry={load} />}
        {sessions && (
          <>
            <Group title="Signed in">
              {sessions.map((s) => (
                <Row key={s.id} label={deviceName(s.userAgent)}>
                  <span className="val">{s.current ? "This browser" : since(s.createdAt)}</span>
                  {!s.current && (
                    <button type="button" className="btn sm danger-text" onClick={() => end(s)}>
                      Sign out
                    </button>
                  )}
                </Row>
              ))}
              <Row label="Every other browser and app">
                <button type="button" className="btn sm danger-text" onClick={endOthers}>
                  Sign out
                </button>
              </Row>
            </Group>

            <Group title="API tokens">
              <Row
                label="New token"
                sub={tokenEdit.error && <span className="form-error">{tokenEdit.error}</span>}
              >
                <button type="button" className="btn sm" onClick={createToken}>
                  New token
                </button>
              </Row>
              {newToken && (
                <div className="row" style={{ display: "grid", gap: 6 }}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Copy this token now. It won't be shown again.
                  </div>
                  <div className="token-new">{newToken.token}</div>
                </div>
              )}
              {tokens.map((t) => (
                <Row key={t.id} label={t.name}>
                  <span className="val">
                    {t.lastUsedAt ? `Used ${day(t.lastUsedAt)}` : "Never used"}
                  </span>
                  <button type="button" className="btn sm danger-text" onClick={() => revoke(t)}>
                    Revoke
                  </button>
                </Row>
              ))}
            </Group>
          </>
        )}
      </div>
    </section>
  );
}
