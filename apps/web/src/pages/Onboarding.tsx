// The guided setup: the model provider's form, then the bot's interview beside a list of its topics.
import {
  API_PREFIX,
  type Onboarding as OnboardingState,
  SETUP_TOPIC_NAMES,
  SETUP_TOPICS,
  type SetupEvent,
  type SetupItem,
  type SetupTurn,
} from "@hatbot/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "../action";
import { ApiError, api, errorText } from "../api";
import { Icon } from "../icons";
import { AssistantBody } from "../markdown";
import { navigate } from "../router";
import { pluginAction } from "../store";
import { Seg } from "../ui";

const LATER = "hatbot:setup-later";

/** "Finish later" holds until the browser's session ends. */
export const setupLater = () => sessionStorage.getItem(LATER) === "1";

const STATE_TEXT = { todo: "", done: "Done", skipped: "Skipped" } as const;

export function Onboarding({ onDone, onLater }: { onDone: () => void; onLater?: () => void }) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState(false);

  const load = useCallback(
    () => api<OnboardingState>("/onboarding").then(setState, (err) => setError(errorText(err))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!state)
    return <div className="login">{error && <div className="form-error">{error}</div>}</div>;
  if (state.needsModels) return <ModelsForm onSaved={setState} />;
  if (summary)
    return (
      <Summary
        items={state.items}
        onBack={() => setSummary(false)}
        onDone={async () => {
          await api("/onboarding/finish", { body: {} });
          onDone();
        }}
      />
    );
  return (
    <Interview
      state={state}
      setState={setState}
      reload={load}
      onFinish={() => setSummary(true)}
      onLater={
        onLater &&
        (() => {
          sessionStorage.setItem(LATER, "1");
          onLater();
        })
      }
    />
  );
}

function ModelsForm({ onSaved }: { onSaved: (s: OnboardingState) => void }) {
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () =>
      onSaved(
        await api<OnboardingState>("/onboarding/models", {
          body: { provider, key, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) },
          timeout: 60_000,
        }),
      ),
    );
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">
          <Icon name="hat" />
        </div>
        <h2>Choose your models</h2>
        <Seg
          value={provider}
          options={[
            ["anthropic", "Anthropic"],
            ["openai", "OpenAI-compatible"],
          ]}
          onChange={setProvider}
        />
        <input
          className="field"
          type="password"
          placeholder={provider === "anthropic" ? "API key (sk-ant-…)" : "API key"}
          aria-label="API key"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        {provider === "openai" && (
          <input
            className="field"
            placeholder="https://openrouter.ai/api/v1"
            aria-label="Address of the API"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="btn accent" type="submit" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

function Interview({
  state,
  setState,
  reload,
  onFinish,
  onLater,
}: {
  state: OnboardingState;
  setState: (fn: (s: OnboardingState | null) => OnboardingState | null) => void;
  reload: () => Promise<void>;
  onFinish: () => void;
  onLater?: () => void;
}) {
  const [live, setLive] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const busy = sending || state.busy;

  const send = useCallback(
    async (turn: SetupTurn) => {
      setSending(true);
      setError("");
      setLive("");
      try {
        const res = await fetch(`${API_PREFIX}/onboarding/turn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(turn),
          credentials: "same-origin",
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let rest = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const lines = (rest + value).split("\n");
          rest = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const e = JSON.parse(line) as SetupEvent;
            if (e.type === "text") setLive((t) => t + e.text);
            else if (e.type === "item") {
              if (e.item.kind === "bot") setLive("");
              const item = e.item;
              setState((s) => s && { ...s, busy: true, items: [...s.items, item] });
            } else {
              setLive("");
              setState(() => e.onboarding);
            }
          }
        }
      } catch (err) {
        setError(errorText(err));
        await reload();
      } finally {
        setSending(false);
      }
    },
    [setState, reload],
  );

  // The bot speaks first; a turn still running from before a reload is waited for.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (state.busy) return;
    if (!state.items.length)
      void send({ start: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  }, [state, send]);
  useEffect(() => {
    if (!state.busy || sending) return;
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [state.busy, sending, reload]);

  useConnectReturn(state, send);

  // biome-ignore lint/correctness/useExhaustiveDependencies: what's new at the end is what it follows
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items.length, live]);

  const say = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send({ say: text });
  };
  const lastBot = state.items.findLastIndex((i) => i.kind !== "change");

  return (
    <div className="setup">
      <aside className="setup-topics">
        <h2>Set up Hatbot</h2>
        <ol>
          {SETUP_TOPICS.map((t) => (
            <li key={t} className={state.topics[t]}>
              <span className="name">{SETUP_TOPIC_NAMES[t]}</span>
              {state.topics[t] === "todo" ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void send({ skip: t })}
                >
                  Skip
                </button>
              ) : (
                <span className="state">
                  {state.topics[t] === "done" && <Icon name="check" />}
                  {STATE_TEXT[state.topics[t]]}
                </span>
              )}
            </li>
          ))}
        </ol>
        <div className="setup-actions">
          {onLater && (
            <button type="button" className="btn" disabled={busy} onClick={onLater}>
              Finish later
            </button>
          )}
          <button type="button" className="btn accent" disabled={busy} onClick={onFinish}>
            Finish
          </button>
        </div>
      </aside>
      <main className="setup-chat">
        <div className="chat-scroll" ref={scroller}>
          <div className="thread">
            {state.items.map((item, i) => (
              <Item
                // biome-ignore lint/suspicious/noArrayIndexKey: items are only ever added at the end
                key={i}
                item={item}
                answerable={i === lastBot && !busy}
                send={send}
              />
            ))}
            {busy && (
              <div className="msg">
                <div className="body">
                  {live ? <AssistantBody text={live} streaming /> : <div className="typing" />}
                </div>
              </div>
            )}
            {error && <div className="form-error">{error}</div>}
          </div>
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <textarea
              rows={1}
              aria-label="Answer Hatbot"
              placeholder="Answer Hatbot…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  say();
                }
              }}
            />
            <button
              type="button"
              className="icon-btn send"
              title="Send"
              disabled={!draft.trim() || busy}
              onClick={say}
            >
              <Icon name="up" />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function Item({
  item,
  answerable,
  send,
}: {
  item: SetupItem;
  answerable: boolean;
  send: (turn: SetupTurn) => Promise<void>;
}) {
  switch (item.kind) {
    case "owner":
      return (
        <div className="msg user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case "bot":
      return (
        <div className="msg">
          <div className="body">
            <AssistantBody text={item.text} />
            {answerable && item.choices?.length ? (
              <div className="choices">
                {item.choices.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="btn"
                    onClick={() => void send({ say: c })}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      );
    case "change":
      return (
        <div className="setup-change">
          <Icon name="check" />
          {item.text}
        </div>
      );
    case "error":
      return <div className="form-error">{item.text}</div>;
    case "secrets":
      return <SecretsForm item={item} send={send} />;
    case "connect":
      return (
        <div className="panel setup-form">
          <b>{item.title}</b>
          {item.state === "open" ? (
            <div className="setup-buttons">
              <a className="btn accent" href={item.url}>
                Connect {item.title}
              </a>
              <button type="button" className="btn" onClick={() => void send({ say: "Skip that" })}>
                Skip
              </button>
            </div>
          ) : (
            <span className="muted">{item.state === "done" ? "Connected" : "Skipped"}</span>
          )}
        </div>
      );
  }
}

function SecretsForm({
  item,
  send,
}: {
  item: Extract<SetupItem, { kind: "secrets" }>;
  send: (turn: SetupTurn) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const open = item.state === "open";
  const missing = item.fields.some((f) => !f.optional && !values[f.name]?.trim());
  return (
    <form
      className="panel setup-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send({ secrets: { id: item.id, values } });
      }}
    >
      <b>{item.title}</b>
      {item.note && <p>{item.note}</p>}
      {open ? (
        <>
          {item.fields.map((f) => (
            <input
              key={f.name}
              className="field mono"
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              aria-label={f.name}
              placeholder={`${f.name}${f.hint ? ` (${f.hint})` : ""}${f.optional ? ", optional" : ""}`}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          ))}
          <div className="setup-buttons">
            <button type="submit" className="btn accent" disabled={missing}>
              Save
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void send({ secrets: { id: item.id, values: null } })}
            >
              Skip
            </button>
          </div>
        </>
      ) : (
        <span className="muted">{item.state === "saved" ? "Saved" : "Skipped"}</span>
      )}
    </form>
  );
}

/** Back from a Connect button: the sign-in finishes, and the bot is told how it went. */
function useConnectReturn(state: OnboardingState, send: (turn: SetupTurn) => Promise<void>) {
  const done = useRef(false);
  useEffect(() => {
    const plugin = /^\/settings\/plugins\/([a-z0-9]+)$/.exec(location.pathname)?.[1];
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const st = params.get("state");
    const denied = params.get("error_description") ?? params.get("error");
    if (!plugin || done.current || state.busy || (!code && !denied)) return;
    const item = state.items.find(
      (i): i is Extract<SetupItem, { kind: "connect" }> =>
        i.kind === "connect" && i.plugin === plugin && i.state === "open",
    );
    done.current = true;
    navigate("/", true);
    if (!item) return;
    void (async () => {
      let error: string | undefined;
      if (denied) error = denied;
      else
        try {
          await pluginAction(plugin)("finish", { code, state: st });
        } catch (err) {
          error = errorText(err, "Couldn't connect.");
        }
      await send({ connected: { id: item.id, ...(error ? { error } : {}) } });
    })();
  }, [state, send]);
}

function Summary({
  items,
  onBack,
  onDone,
}: {
  items: SetupItem[];
  onBack: () => void;
  onDone: () => Promise<void>;
}) {
  const changes = items.flatMap((i) => (i.kind === "change" ? [i.text] : []));
  const { busy, error, run } = useAction();
  return (
    <div className="login">
      <div className="login-card setup-summary">
        <h2>All set</h2>
        {changes.length ? (
          <ul>
            {changes.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing was changed.</p>
        )}
        {error && <div className="form-error">{error}</div>}
        <button
          type="button"
          className="btn accent"
          disabled={busy}
          onClick={() => void run(onDone)}
        >
          Go to the chat
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
