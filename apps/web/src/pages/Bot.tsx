// A bot's page (PLAN.md §14): its name, role, model and plugins. "new" makes one, from a template or not.
import { BOT_COLORS, BOT_ICONS, BOT_TEMPLATES, type Bot, HATBOT_ID } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { BotMark, Icon } from "../icons";
import { navigate } from "../router";
import { createBot, deleteBot, loadPlugins, saveBot, useStore } from "../store";
import { Switch } from "../switch";

type Form = {
  name: string;
  icon: Bot["icon"];
  color: Bot["color"];
  instructions: string;
  chatModel: Bot["chatModel"];
  chatEffort: Bot["chatEffort"];
  /** null: every plugin that's on. */
  plugins: string[] | null;
};

const EMPTY: Form = {
  name: "",
  icon: "sparkles",
  color: "amber",
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
  // A new bot starts in a colour none of the others has yet.
  const freeColor = useStore((s) => {
    const used = s.botIds.map((b) => s.bots[b]?.color);
    const count = (c: Bot["color"]) => used.filter((u) => u === c).length;
    return BOT_COLORS.reduce((best, c) => (count(c) < count(best) ? c : best));
  });
  const [form, setForm] = useState<Form>(EMPTY);
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadPlugins().catch(() => {});
  }, []);
  useEffect(() => {
    if (stored) setForm({ ...stored });
  }, [stored]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the page opens, not as bots change
  useEffect(() => {
    if (isNew) {
      setForm({ ...EMPTY, color: freeColor });
      setTemplate("");
    }
  }, [isNew]);

  if (!isNew && !stored) return <section className="view" />;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const pickTemplate = (key: string) => {
    const t = BOT_TEMPLATES.find((x) => x.id === key);
    setTemplate(key);
    if (t) {
      const { id: _, ...fields } = t;
      setForm(fields);
    } else setForm({ ...EMPTY, color: freeColor });
  };
  const changed =
    isNew ||
    (stored !== undefined &&
      (form.name !== stored.name ||
        form.icon !== stored.icon ||
        form.color !== stored.color ||
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
          {isNew && (
            <div className="form-row">
              <span className="label">Template</span>
              <select
                className="field"
                value={template}
                onChange={(e) => pickTemplate(e.target.value)}
              >
                <option value="">None</option>
                {BOT_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
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
          <fieldset className="bot-field">
            <legend className="label">Icon</legend>
            <div className="bot-picks">
              {BOT_ICONS.map((icon) => (
                <button
                  type="button"
                  key={icon}
                  aria-pressed={form.icon === icon}
                  aria-label={icon}
                  className={`bot-pick ${form.icon === icon ? "on" : ""}`}
                  onClick={() => set({ icon })}
                >
                  <BotMark bot={{ icon, color: form.color }} />
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="bot-field">
            <legend className="label">Colour</legend>
            <div className="bot-picks">
              {BOT_COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  aria-pressed={form.color === color}
                  aria-label={color}
                  className={`bot-pick ${form.color === color ? "on" : ""}`}
                  onClick={() => set({ color })}
                >
                  <span className="swatch" style={{ background: `var(--bot-${color})` }} />
                </button>
              ))}
            </div>
          </fieldset>
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
                  onChange={(on) =>
                    set({
                      plugins: on ? null : pluginList.filter((p) => p.enabled).map((p) => p.id),
                    })
                  }
                />
              </div>
              {form.plugins !== null &&
                pluginList.map((p) => (
                  <div className="form-row" key={p.id}>
                    <span>{p.name}</span>
                    {/* Only plugins that are on reach a bot; the others link to where they're turned on. */}
                    {p.enabled ? (
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
                    ) : (
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => navigate(`/settings/plugins/${p.id}`)}
                      >
                        Off in Settings
                      </button>
                    )}
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
