import { MAX_GROUP_BOTS } from "@hatbot/shared";
import { useAction } from "../action";
import { ask, useLeaveGuard } from "../confirm";
import { toggled, useStoredForm } from "../form";
import { PageLoad, useLoad } from "../load";
import { navigate } from "../router";
import { chatPath, createGroup, deleteGroup, loadBots, saveGroup, useStore } from "../store";
import { Switch } from "../switch";
import { BackHead, SaveBar } from "../ui";

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
  const { busy, error, run } = useAction();
  const release = useLeaveGuard(dirty);
  // The chats again, to tell one that's gone from one not loaded yet.
  const load = useLoad(
    () => (isNew ? Promise.resolve(false) : loadBots().then(() => true)),
    [isNew],
  );

  const back = isNew || !stored ? "/" : chatPath(Number(id));
  if (!form || (!isNew && !stored))
    return (
      <PageLoad
        error={load.error}
        missing={load.data ? "This group doesn't exist." : ""}
        retry={load.retry}
        back={{ label: "Chat", to: back }}
      />
    );
  const { title, members } = form;
  const setMembers = (fn: (m: string[]) => string[]) => set({ members: fn(members) });
  const changed = isNew || dirty;
  const valid = members.length >= 2 && members.length <= MAX_GROUP_BOTS;

  const save = () =>
    run(async () => {
      const body = { title: title.trim(), botIds: members };
      if (isNew) {
        const c = await createGroup(body);
        release();
        navigate(chatPath(c.id), true);
      } else {
        await saveGroup(Number(id), body);
        // What was saved, trimmed: the form is clean again, unless you went on editing.
        saved(form, { title: body.title, members });
        toast("Saved");
      }
    });
  const remove = async () => {
    if (
      !(await ask({
        text: `Delete ${title || "this group"}? Its messages go with it.`,
        ok: "Delete",
      }))
    )
      return;
    await run(async () => {
      await deleteGroup(Number(id));
      release();
      navigate("/");
    });
  };

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to={back} label="Chat">
          {!isNew && (
            <button type="button" className="btn sm danger-text" onClick={remove}>
              Delete
            </button>
          )}
        </BackHead>

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
          <SaveBar
            error={error}
            disabled={busy || !changed || !valid}
            onSave={save}
            label={isNew ? "Create" : "Save"}
          />
        </div>
      </div>
    </section>
  );
}
