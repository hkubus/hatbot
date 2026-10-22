import {
  type AppSettings,
  BOT_COLORS,
  BOT_ICONS,
  BOT_TEMPLATES,
  type Bot,
  HATBOT_ID,
} from "@hatbot/shared";
import { useEffect, useState } from "react";
import { useAction } from "../action";
import { api } from "../api";
import { ask, useLeaveGuard } from "../confirm";
import { toggled, useStoredForm } from "../form";
import { BotMark } from "../icons";
import { Link } from "../link";
import { PageLoad, useLoad } from "../load";
import { navigate } from "../router";
import { chatPath, createBot, deleteBot, loadBot, loadPlugins, saveBot, useStore } from "../store";
import { Switch } from "../switch";
import { BackHead, CHAT_MODELS, EFFORTS, MODELS, SaveBar, Select } from "../ui";

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

const byDefault = (options: readonly (readonly [string, string])[], id?: string) => {
  const name = options.find(([v]) => v === id)?.[1];
  return name ? `Default (${name})` : "Default";
};

const formOf = (b: Form): Form => ({
  name: b.name,
  icon: b.icon,
  color: b.color,
  instructions: b.instructions,
  chatModel: b.chatModel,
  chatEffort: b.chatEffort,
  plugins: b.plugins,
});

export function BotPage({ id, toast }: { id: string; toast: (t: string) => void }) {
  const isNew = id === "new";
  const stored = useStore((s) => (isNew ? undefined : s.bots[id]));
  // Deleted, here or elsewhere, once the bots are known.
  const gone = useStore((s) => s.botIds.length > 0 && !s.botIds.includes(id));
  // The whole bot: a list's has only its role's first line, and saving that would cut the role.
  const [full, setFull] = useState<Bot>();
  useEffect(() => {
    if (stored && !stored.brief) setFull(stored);
  }, [stored]);
  const chat = useStore((s) =>
    s.conversations.find((c) => c.kind === "direct" && c.botIds[0] === id),
  );
  const plugins = useStore((s) => s.plugins);
  const freeColor = useStore((s) => {
    const used = s.botIds.map((b) => s.bots[b]?.color);
    const count = (c: Bot["color"]) => used.filter((u) => u === c).length;
    return BOT_COLORS.reduce((best, c) => (count(c) < count(best) ? c : best));
  });
  const [start] = useState<Form>(() => ({ ...EMPTY, color: freeColor }));
  const { form, base, dirty, set, fill, saved } = useStoredForm<Form>(
    isNew ? start : full && formOf(full),
  );
  const [template, setTemplate] = useState("");
  const { busy, error, run } = useAction();
  const release = useLeaveGuard(dirty);
  const load = useLoad(
    () =>
      isNew
        ? Promise.resolve(null)
        : loadBot(id).then((b) => {
            setFull(b);
            return b;
          }),
    [isNew, id],
  );
  const missing = load.missing;

  const [defaults, setDefaults] = useState<AppSettings>();
  useEffect(() => {
    void loadPlugins().catch(() => {});
    api<AppSettings>("/settings").then(setDefaults, () => {});
  }, []);

  const back = chat ? chatPath(chat.id) : "/";
  if (!isNew && (missing || gone || !form))
    return (
      <PageLoad
        error={load.error}
        missing={missing || gone ? "This bot doesn't exist." : ""}
        retry={load.retry}
        back={{ label: "Chat", to: back }}
      />
    );
  if (!form) return null;
  const pickTemplate = async (key: string) => {
    const t = BOT_TEMPLATES.find((x) => x.id === key);
    // What you've written isn't thrown away unasked.
    if (
      dirty &&
      !(await ask({
        text: t
          ? `Replace what you've written with the ${t.name} template?`
          : "Clear what you've written?",
        ok: t ? "Replace" : "Clear",
      }))
    )
      return;
    setTemplate(key);
    fill(t ? formOf(t) : start);
  };
  const changed = isNew || dirty;
  const isHatbot = id === HATBOT_ID;
  const pluginList = Object.values(plugins).sort((a, b) => a.name.localeCompare(b.name));

  const save = () =>
    run(async () => {
      const body = { ...form, name: form.name.trim() };
      if (isNew) {
        const bot = await createBot(body);
        release();
        navigate(`/bots/${bot.id}`, true);
        toast(`Made ${bot.name}`);
      } else {
        // What was saved: the form is clean again, unless you went on editing.
        saved(form, formOf(await saveBot(id, isHatbot ? { ...body, name: undefined } : body)));
        toast("Saved");
      }
    });
  const remove = async () => {
    if (!stored) return;
    if (
      !(await ask({
        text: `Delete ${stored.name}? Its chat goes away. Its notes stay in Memory, and its schedules, triggers and watchers go to Hatbot, switched off until you turn them back on. If the heartbeat runs as it, it's switched off too.`,
        ok: "Delete",
      }))
    )
      return;
    await run(async () => {
      await deleteBot(id);
      release();
      navigate("/");
    });
  };

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to={back} label="Chat">
          {!isNew && !isHatbot && (
            <button type="button" className="btn sm danger-text" onClick={remove}>
              Delete
            </button>
          )}
        </BackHead>

        <div className="panel form">
          {isNew && (
            <div className="form-row">
              <span className="label">Template</span>
              <Select
                className="field"
                label="Template"
                value={template}
                options={[["", "None"], ...BOT_TEMPLATES.map((t) => [t.id, t.name] as const)]}
                onChange={pickTemplate}
              />
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
            <Select
              className="field"
              label="Model"
              value={form.chatModel ?? ""}
              options={[["", byDefault(MODELS, defaults?.chatModel)], ...CHAT_MODELS]}
              onChange={(chatModel) => set({ chatModel: chatModel || null })}
            />
          </div>
          <div className="form-row">
            <span className="label">Effort</span>
            <Select
              className="field"
              label="Effort"
              value={form.chatEffort ?? ""}
              options={[["", byDefault(EFFORTS, defaults?.chatEffort)], ...EFFORTS]}
              onChange={(chatEffort) => set({ chatEffort: chatEffort || null })}
            />
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
                        label={p.name}
                        on={form.plugins?.includes(p.id) ?? false}
                        onChange={(on) =>
                          set({
                            plugins: toggled(
                              form.plugins ?? [],
                              p.id,
                              on,
                              base?.plugins ?? [],
                              pluginList.map((x) => x.id),
                            ),
                          })
                        }
                      />
                    ) : (
                      <Link className="text-link" to={`/settings/plugins/${p.id}`}>
                        Off in Plugins
                      </Link>
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
                  <Link className="text-link" to="/memory">
                    Memory
                  </Link>
                ) : (
                  <Link className="text-link" to={`/memory?path=bots/${id}/INDEX.md`}>
                    bots/{id}/
                  </Link>
                )}
              </dd>
            </dl>
          )}
          <SaveBar
            error={error}
            disabled={busy || !changed || !form.name.trim()}
            onSave={save}
            label={isNew ? "Create" : "Save"}
          />
        </div>
      </div>
    </section>
  );
}
