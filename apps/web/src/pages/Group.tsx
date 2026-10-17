// A group chat's page (PLAN.md §14.4): its name and bots. "new" makes one.
import { MAX_GROUP_BOTS } from "@hatbot/shared";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { NoForm, toggled, useStoredForm } from "../form";
import { Icon } from "../icons";
import { loadErrorText } from "../load";
import { navigate } from "../router";
import { createGroup, deleteGroup, loadBots, saveGroup, useStore } from "../store";
import { Switch } from "../switch";

const NEW_GROUP = { title: "", members: [] as string[] };

export function GroupPage({ id, toast }: { id: string; toast: (t: string) => void }) {
  const isNew = id === "new";
  const stored = useStore((s) =>
    isNew ? undefined : s.conversations.find((c) => c.id === Number(id) && c.kind === "group"),
  );
  const bots = useStore((s) => s.bots);
  const botIds = useStore((s) => s.botIds);
  // Only its name and bots: the chat's unread count and order change all the time.
  const { form, base, dirty, set, saved } = useStoredForm<{ title: string; members: string[] }>(
    isNew ? NEW_GROUP : stored && { title: stored.title ?? "", members: stored.botIds },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const release = useLeaveGuard(dirty);
  // The chats again, to tell one that's gone from one not loaded yet.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(() => {
    setLoadError("");
    loadBots().then(
      () => setLoaded(true),
      (err) => setLoadError(loadErrorText(err)),
    );
  }, []);
  useEffect(() => {
    if (!isNew) load();
  }, [isNew, load]);

  const back = () => navigate(isNew || !stored ? "/" : `/chat/${id}`);
  if (!form || (!isNew && !stored))
    return (
      <NoForm
        error={loadError}
        missing={loaded ? "This group doesn't exist." : ""}
        retry={load}
        back={{ label: "Chat", go: back }}
      />
    );
  const { title, members } = form;
  const setMembers = (fn: (m: string[]) => string[]) => set({ members: fn(members) });
  const changed = isNew || dirty;
  const valid = members.length >= 2 && members.length <= MAX_GROUP_BOTS;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { title: title.trim(), botIds: members };
      if (isNew) {
        const c = await createGroup(body);
        release();
        navigate(`/chat/${c.id}`, true);
      } else {
        await saveGroup(Number(id), body);
        // What was saved, trimmed: the form is clean again, unless you went on editing.
        saved(form, { title: body.title, members });
        toast("Saved");
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await ask({
        text: `Delete ${title || "this group"}? Its messages go with it.`,
        ok: "Delete",
      }))
    )
      return;
    try {
      await deleteGroup(Number(id));
      release();
      navigate("/");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button type="button" className="btn sm ghost back" onClick={back}>
            <Icon name="chevron" />
            Chat
          </button>
          <span className="spacer" />
          {!isNew && (
            <button type="button" className="btn sm danger-text" onClick={remove}>
              Delete
            </button>
          )}
        </div>

        <div className="panel form">
          <label>
            <span className="label">Name</span>
            <input
              className="field"
              value={title}
              maxLength={80}
              placeholder="Kitchen"
              onChange={(e) => set({ title: e.target.value })}
            />
          </label>
          <span className="label">Bots, 2 to {MAX_GROUP_BOTS}</span>
          {botIds.map((b) => (
            <div className="form-row" key={b}>
              <span>{bots[b]?.name ?? b}</span>
              <Switch
                label={bots[b]?.name ?? b}
                on={members.includes(b)}
                onChange={(on) => setMembers((m) => toggled(m, b, on, base?.members ?? [], botIds))}
              />
            </div>
          ))}
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button
              type="button"
              className="btn accent"
              disabled={busy || !changed || !valid}
              onClick={save}
            >
              {isNew ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
