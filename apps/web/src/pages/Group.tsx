// A group chat's page (PLAN.md §14.4): its name and bots. "new" makes one.
import { MAX_GROUP_BOTS } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { ask } from "../confirm";
import { Icon } from "../icons";
import { navigate } from "../router";
import { createGroup, deleteGroup, saveGroup, useStore } from "../store";
import { Switch } from "../switch";

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Couldn't reach Hatbot.";

export function GroupPage({ id, toast }: { id: string; toast: (t: string) => void }) {
  const isNew = id === "new";
  const stored = useStore((s) =>
    isNew ? undefined : s.conversations.find((c) => c.id === Number(id) && c.kind === "group"),
  );
  const bots = useStore((s) => s.bots);
  const botIds = useStore((s) => s.botIds);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (stored) {
      setTitle(stored.title ?? "");
      setMembers(stored.botIds);
    }
  }, [stored]);

  if (!isNew && !stored) return <section className="view" />;
  const changed =
    isNew ||
    (stored !== undefined &&
      (title !== (stored.title ?? "") ||
        JSON.stringify(members) !== JSON.stringify(stored.botIds)));
  const valid = members.length >= 2 && members.length <= MAX_GROUP_BOTS;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { title: title.trim(), botIds: members };
      if (isNew) {
        const c = await createGroup(body);
        navigate(`/chat/${c.id}`, true);
      } else {
        await saveGroup(Number(id), body);
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
      navigate("/");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="view">
      <div className="page narrow">
        <div className="page-head">
          <button
            type="button"
            className="btn sm ghost back"
            onClick={() => navigate(isNew ? "/" : `/chat/${id}`)}
          >
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
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <span className="label">Bots, 2 to {MAX_GROUP_BOTS}</span>
          {botIds.map((b) => (
            <div className="form-row" key={b}>
              <span>{bots[b]?.name ?? b}</span>
              <Switch
                on={members.includes(b)}
                onChange={(on) => setMembers((m) => (on ? [...m, b] : m.filter((x) => x !== b)))}
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
