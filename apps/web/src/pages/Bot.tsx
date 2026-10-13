// A bot's page (PLAN.md §14): its name, role, model and plugins. "new" makes one.
import { type Bot, HATBOT_ID } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { Icon } from "../icons";
import { navigate } from "../router";
import { createBot, deleteBot, loadPlugins, saveBot, useStore } from "../store";
import { Switch } from "../switch";

type Form = {
  name: string;
  instructions: string;
  chatModel: Bot["chatModel"];
  chatEffort: Bot["chatEffort"];
  /** null: every plugin that's on. */
  plugins: string[] | null;
};

const EMPTY: Form = {
  name: "",
  instructions: "",
  chatModel: null,
  chatEffort: null,
  plugins: null,
};

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Couldn't reach Hatbot.";

export function BotPage({ id, toast }: { id: string; toast: (t: string) => void }) {
  const isNew = id === "new";
  const stored = useStore((s) => (isNew ? undefined : s.bots[id]));
  const chat = useStore((s) =>
    s.conversations.find((c) => c.kind === "direct" && c.botIds[0] === id),
  );
  const plugins = useStore((s) => s.plugins);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadPlugins().catch(() => {});
  }, []);
  useEffect(() => {
    if (stored) setForm({ ...stored });
  }, [stored]);

  if (!isNew && !stored) return <section className="view" />;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const changed =
    isNew ||
    (stored !== undefined &&
      (form.name !== stored.name ||
        form.instructions !== stored.instructions ||
        form.chatModel !== stored.chatModel ||
        form.chatEffort !== stored.chatEffort ||
        JSON.stringify(form.plugins) !== JSON.stringify(stored.plugins)));
  const isHatbot = id === HATBOT_ID;
  const pluginList = Object.values(plugins).sort((a, b) => a.name.localeCompare(b.name));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { ...form, name: form.name.trim() };
      if (isNew) {
        const bot = await createBot(body);
        navigate(`/bots/${bot.id}`, true);
        toast(`Made ${bot.name}`);
      } else {
        await saveBot(id, isHatbot ? { ...body, name: undefined } : body);
        toast("Saved");
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!stored) return;
    if (
      !confirm(
        `Delete ${stored.name}? Its chat and notes stay readable; its schedules and triggers go to Hatbot.`,
      )
    )
      return;
    try {
      await deleteBot(id);
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
            onClick={() => navigate(chat ? (chat.id === 1 ? "/" : `/chat/${chat.id}`) : "/")}
          >
            <Icon name="chevron" />
            Chat
          </button>
          <span className="spacer" />
          {!isNew && !isHatbot && (
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
              value={form.name}
              maxLength={40}
              disabled={isHatbot}
              placeholder="Chef"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label>
            <span className="label">Role</span>
            <textarea
              className="field"
              rows={6}
              maxLength={4000}
              value={form.instructions}
              placeholder="Plans the week's meals around what's in the fridge. Keeps the shopping list."
              onChange={(e) => set({ instructions: e.target.value })}
            />
          </label>
          <div className="form-row">
            <span className="label">Model</span>
            <select
              className="field"
              value={form.chatModel ?? ""}
              onChange={(e) => set({ chatModel: (e.target.value || null) as Form["chatModel"] })}
            >
              <option value="">As in Settings</option>
              <option value="claude-haiku-5-5">Haiku 5.5, asks Opus for hard parts</option>
              <option value="claude-opus-5-5">Opus 5.5</option>
            </select>
          </div>
          <div className="form-row">
            <span className="label">Effort</span>
            <select
              className="field"
              value={form.chatEffort ?? ""}
              onChange={(e) => set({ chatEffort: (e.target.value || null) as Form["chatEffort"] })}
            >
              <option value="">As in Settings</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
            </select>
          </div>
          {pluginList.length > 0 && (
            <>
              <div className="form-row">
                <span className="label">Every plugin that's on</span>
                <Switch
                  on={form.plugins === null}
                  onChange={(on) => set({ plugins: on ? null : pluginList.map((p) => p.id) })}
                />
              </div>
              {form.plugins !== null &&
                pluginList.map((p) => (
                  <div className="form-row" key={p.id}>
                    <span>{p.name}</span>
                    <Switch
                      on={form.plugins?.includes(p.id) ?? false}
                      onChange={(on) =>
                        set({
                          plugins: on
                            ? [...(form.plugins ?? []), p.id]
                            : (form.plugins ?? []).filter((x) => x !== p.id),
                        })
                      }
                    />
                  </div>
                ))}
            </>
          )}
          {!isNew && (
            <dl className="kv">
              <dt>Its notes</dt>
              <dd>
                {isHatbot ? (
                  <button type="button" className="text-link" onClick={() => navigate("/memory")}>
                    Memory
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => navigate(`/memory?path=bots/${id}/INDEX.md`)}
                  >
                    bots/{id}/
                  </button>
                )}
              </dd>
            </dl>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="form-actions">
            <button
              type="button"
              className="btn accent"
              disabled={busy || !changed || !form.name.trim()}
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
