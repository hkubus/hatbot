import type { Conversation, Me } from "@hatbot/shared";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorText } from "./api";
import { BotMark, Icon, type IconName } from "./icons";
import { LiveView } from "./live";
import { useMedia } from "./media";
import { BotPage } from "./pages/Bot";
import { Chat } from "./pages/Chat";
import { GroupPage } from "./pages/Group";
import { Login, Setup } from "./pages/Login";
import { Search } from "./pages/Search";
import { TaskDetail, Tasks } from "./pages/Tasks";
import { navigate, useRoute } from "./router";
import {
  chatName,
  chatPath,
  connect,
  currentChat,
  disconnect,
  getState,
  HATBOT_CHAT,
  loadApproval,
  loadNegotiations,
  needsYou,
  negotiationOf,
  onToast,
  reconnectNow,
  setIncognito,
  setPaused,
  unreadCount,
  useStore,
} from "./store";
import { setTheme, type Theme, useTheme } from "./theme";
import { TOAST_ICON, type Toast, type ToastKind } from "./toast";

// Pages you open now and then load when first opened; chat and tasks come with the app.
const BoxesPage = lazy(() => import("./pages/Boxes").then((m) => ({ default: m.BoxesPage })));
const BoxPage = lazy(() => import("./pages/Boxes").then((m) => ({ default: m.BoxPage })));
const NegotiationPage = lazy(() =>
  import("./pages/Negotiation").then((m) => ({ default: m.NegotiationPage })),
);
const Memory = lazy(() => import("./pages/Memory").then((m) => ({ default: m.Memory })));
const Reader = lazy(() => import("./pages/Reader").then((m) => ({ default: m.Reader })));
const SchedulesView = lazy(() =>
  import("./pages/Schedules").then((m) => ({ default: m.SchedulesView })),
);
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const SkillDraft = lazy(() =>
  import("./pages/SkillDraft").then((m) => ({ default: m.SkillDraft })),
);
const Spend = lazy(() => import("./pages/Spend").then((m) => ({ default: m.Spend })));
const TodoPage = lazy(() => import("./pages/Todo").then((m) => ({ default: m.TodoPage })));

const VIEWS = [
  { path: "/", title: "Chat", icon: "chat", phone: true },
  { path: "/tasks", title: "Tasks", icon: "tasks", phone: true },
  { path: "/todo", title: "To-do", icon: "check", phone: false },
  { path: "/boxes", title: "Boxes", icon: "box", phone: false },
  { path: "/search", title: "Search", icon: "search", phone: false },
  { path: "/live", title: "Live", icon: "monitor", phone: true },
  { path: "/schedules", title: "Schedules & Triggers", icon: "clock", phone: false },
  { path: "/memory", title: "Memory", icon: "book", phone: true },
  { path: "/spend", title: "Spend", icon: "gauge", phone: false },
  { path: "/settings", title: "Settings", icon: "sliders", phone: true },
] as const satisfies readonly { path: string; title: string; icon: IconName; phone: boolean }[];
type View = (typeof VIEWS)[number];

/** Pages that belong to another view than their first segment names. */
const VIEW_OF: Record<string, string> = {
  chat: "/",
  bots: "/",
  groups: "/",
  negotiations: "/tasks",
  read: "/memory",
  triggers: "/schedules",
  watchers: "/schedules",
};
const viewOf = (path: string) => {
  const first = path.split("/")[1] ?? "";
  return VIEWS.find((v) => v.path === (VIEW_OF[first] ?? `/${first}`)) ?? VIEWS[0];
};
/** On a phone, To-do, Boxes, Spend and Schedules are reached from Settings, so its tab stays lit. */
const TAB_OF: Record<string, string> = {
  "/todo": "/settings",
  "/boxes": "/settings",
  "/spend": "/settings",
  "/schedules": "/settings",
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  // Only a 401 means you're signed out; anything else is the brain or the network being down.
  const refresh = useCallback(() => {
    api<Me>("/auth/me").then(
      (m) => {
        setUnreachable(false);
        setMe(m);
      },
      (err) => {
        const out = err instanceof ApiError && err.status === 401;
        if (out) setMe({ setupDone: true, authenticated: false });
        setUnreachable(!out);
      },
    );
  }, []);
  // A restart, say: it tries again on its own every 5 s, keeping the message up meanwhile.
  useEffect(() => {
    if (!unreachable || me) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [unreachable, me, refresh]);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => setMe((m) => (m ? { ...m, authenticated: false } : m));
    window.addEventListener("hatbot:unauthorized", onUnauthorized);
    return () => window.removeEventListener("hatbot:unauthorized", onUnauthorized);
  }, [refresh]);

  if (!me && unreachable)
    return (
      <div className="unreachable">
        Can't reach Hatbot.
        <button type="button" className="btn sm" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  if (!me) return null;
  if (!me.setupDone) return <Setup onDone={refresh} />;
  if (!me.authenticated) return <Login onDone={refresh} />;
  return <Shell onSignOut={refresh} />;
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const { path, params } = useRoute();
  const theme = useTheme();
  const pending = useStore(needsYou);
  const unread = useStore(unreadCount);
  const incognito = useStore((s) => s.incognito);
  const chats = useStore((s) => s.conversations);
  const chat = useStore(currentChat);
  const title = useStore((s) => chatName(s, currentChat(s)));
  const [chatMenu, setChatMenu] = useState(false);
  const chatMenuEl = useRef<HTMLDivElement>(null);
  const chatSwitch = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!chatMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!chatMenuEl.current?.contains(t) && !chatSwitch.current?.contains(t)) setChatMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [chatMenu]);
  const connected = useStore((s) => s.connected);
  // A blip while reconnecting isn't worth a banner.
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (connected) return setDown(false);
    const t = setTimeout(() => setDown(true), 4000);
    return () => clearTimeout(t);
  }, [connected]);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: ToastKind }[]>([]);
  const [insp, setInsp] = useState(() => localStorage.getItem("hatbot:insp") === "1");
  // The reader is Memory's for a note; an attachment's stays with the view it was opened from.
  const reading = path === "/read";
  const openedFrom = useRef<View>(VIEWS[0]);
  const view = reading && !params.get("path") ? openedFrom.current : viewOf(path);
  if (!reading) openedFrom.current = view;
  const page = reading ? "" : view.path;
  // The side panel is hidden on a phone; it isn't drawn either, or its live view would stream unseen.
  const wide = useMedia("(min-width: 900px)");
  const taskId = /^\/tasks\/(\d+)$/.exec(path)?.[1];
  const negotiationId = /^\/negotiations\/(\d+)$/.exec(path)?.[1];
  const boxId = /^\/boxes\/(\d+)$/.exec(path)?.[1];
  const teachId = /^\/memory\/teach\/(\d+)$/.exec(path)?.[1];
  const approvalId = Number(params.get("approval"));
  const botPage = /^\/bots\/([a-z0-9-]+)$/.exec(path)?.[1];
  const groupPage = /^\/groups\/(new|\d+)$/.exec(path)?.[1];
  const chatId = path === "/" ? HATBOT_CHAT : Number(/^\/chat\/(\d+)$/.exec(path)?.[1] ?? 0);
  const pageChat = useStore((s) =>
    botPage
      ? s.conversations.find((c) => c.kind === "direct" && c.botIds[0] === botPage)
      : s.conversations.find((c) => c.kind === "group" && String(c.id) === groupPage),
  );
  const pageTitle = useStore((s) =>
    botPage === "new"
      ? "New bot"
      : botPage
        ? (s.bots[botPage]?.name ?? "Bot")
        : groupPage === "new"
          ? "New group"
          : groupPage
            ? pageChat
              ? chatName(s, pageChat)
              : "Group"
            : ((negotiationId ? s.negotiations[Number(negotiationId)]?.title : undefined) ??
              (boxId ? s.boxes[Number(boxId)]?.title : undefined) ??
              view.title),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every navigation
  useEffect(() => setChatMenu(false), [path]);
  // One that's gone, e.g. a deleted bot's: back to Hatbot's.
  useEffect(() => {
    if (chatId && chats.length && !chats.some((c) => c.id === chatId)) navigate("/", true);
  }, [chatId, chats]);

  // An approval notification opens /?approval=<id>: show it on its task.
  useEffect(() => {
    if (!approvalId) return;
    loadApproval(approvalId).then(
      async (a) => {
        if (a.taskId) return navigate(`/tasks/${a.taskId}`, true);
        if (a.kind === "mandate") await loadNegotiations().catch(() => {});
        const n = negotiationOf(getState(), a.id);
        navigate(n ? `/negotiations/${n.id}` : "/", true);
      },
      () => navigate("/", true),
    );
  }, [approvalId]);

  const toast = useCallback<Toast>((text, kind = "done") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);

  useEffect(() => {
    onToast(toast);
    connect();
    return disconnect;
  }, [toast]);

  // A file dropped where nothing takes it would replace the app with the file; a chat takes it.
  useEffect(() => {
    const keep = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);

  useEffect(() => {
    const n = unread + pending;
    document.title = n ? `(${n}) Hatbot` : "Hatbot";
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    void (n ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
  }, [unread, pending]);
  useEffect(
    () => () => {
      (navigator as Navigator & { clearAppBadge?: () => Promise<void> })
        .clearAppBadge?.()
        .catch(() => {});
    },
    [],
  );

  // Cmd/Ctrl-K: Search. Escape: closes the chat switcher, else the live panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (location.pathname === "/search")
          document.querySelector<HTMLInputElement>(".search-box input")?.focus();
        else navigate("/search");
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (chatMenu) return setChatMenu(false);
      // Escape in a field, or typed on the desktop in the live view, is theirs.
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, canvas, [contenteditable]")) return;
      if (insp) {
        localStorage.setItem("hatbot:insp", "0");
        setInsp(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [chatMenu, insp]);

  const cycleTheme = () => {
    const order: Theme[] = ["system", "light", "dark"];
    setTheme(order[(order.indexOf(theme) + 1) % 3] as Theme);
  };
  const toggleInsp = () => {
    localStorage.setItem("hatbot:insp", insp ? "0" : "1");
    setInsp(!insp);
  };

  return (
    <>
      <div className={`app ${insp && view.path !== "/live" ? "insp" : ""}`}>
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Icon name="hat" />
            </div>
            <div className="brand-name">Hatbot</div>
          </div>
          <nav className="nav">
            <ChatNav current={chatId || pageChat?.id || 0} path={path} />
          </nav>
          <nav className="nav nav-views">
            {VIEWS.filter((v) => v.path !== "/").map((v) => (
              <button
                type="button"
                key={v.path}
                className={`nav-item ${v === view ? "active" : ""}`}
                onClick={() => navigate(v.path)}
              >
                <Icon name={v.icon} />
                <span>{v.title}</span>
                {v.path === "/tasks" && pending > 0 && (
                  <span className="count attn">{pending}</span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        <main className="main">
          <header className="toolbar">
            {chatId ? (
              <>
                <h1 className="hide-phone">{incognito ? `${title} · Incognito` : title}</h1>
                <button
                  ref={chatSwitch}
                  type="button"
                  className="chat-switch show-phone-inline"
                  aria-expanded={chatMenu}
                  onClick={() => setChatMenu((v) => !v)}
                >
                  <h1>{incognito ? `${title} · Incognito` : title}</h1>
                  <Icon name="chevron" />
                </button>
              </>
            ) : (
              <h1>{pageTitle}</h1>
            )}
            <span className="spacer" />
            {chat && chatId > 0 && (
              <button
                type="button"
                className="tb-btn"
                onClick={() =>
                  navigate(chat.kind === "group" ? `/groups/${chat.id}` : `/bots/${chat.botIds[0]}`)
                }
                title={`About ${title}`}
              >
                <Icon name="sliders" />
              </button>
            )}
            {chatId > 0 && chat?.kind !== "group" && (
              <button
                type="button"
                className={`tb-btn ${incognito ? "on" : ""}`}
                onClick={() => void setIncognito(!incognito)}
                title={incognito ? "Leave incognito" : "Incognito"}
              >
                <Icon name="incognito" />
              </button>
            )}
            {view.path !== "/search" && (
              <button
                type="button"
                className="tb-btn show-phone"
                onClick={() => navigate("/search")}
                title="Search"
              >
                <Icon name="search" />
              </button>
            )}
            {view.path !== "/live" && (
              <button
                type="button"
                className={`tb-btn hide-phone ${insp ? "on" : ""}`}
                onClick={toggleInsp}
                title="Live view"
              >
                <Icon name="monitor" />
              </button>
            )}
            <button type="button" className="tb-btn" onClick={cycleTheme} title={`Theme: ${theme}`}>
              <Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "auto"} />
            </button>
          </header>
          {down && (
            <div className="paused-banner offline-banner">
              Can't reach Hatbot.
              <span className="spacer" />
              <button type="button" className="btn sm" onClick={reconnectNow}>
                Retry
              </button>
            </div>
          )}
          <PausedBanner />
          {chatMenu && chatId > 0 && (
            <div className="chat-menu" ref={chatMenuEl}>
              <ChatNav current={chatId} path={path} onPick={() => setChatMenu(false)} />
            </div>
          )}
          {chatId > 0 && <Chat key={chatId} id={chatId} />}
          {botPage && <BotPage key={botPage} id={botPage} toast={toast} />}
          {groupPage && <GroupPage key={groupPage} id={groupPage} toast={toast} />}
          {page === "/tasks" &&
            !negotiationId &&
            (taskId ? (
              <TaskDetail key={taskId} id={Number(taskId)} live={params.get("live") === "1"} />
            ) : (
              <Tasks />
            ))}
          {page === "/live" && (
            <section className="view">
              <div className="page live-page">
                <LiveView />
              </div>
            </section>
          )}
          <Suspense fallback={<section className="view" />}>
            {negotiationId && <NegotiationPage key={negotiationId} id={Number(negotiationId)} />}
            {page === "/schedules" && <SchedulesView path={path} params={params} />}
            {page === "/memory" &&
              (teachId ? (
                <SkillDraft key={teachId} id={Number(teachId)} toast={toast} />
              ) : (
                <Memory
                  key={params.get("path") ?? ""}
                  toast={toast}
                  open={params.get("path") ?? ""}
                />
              ))}
            {page === "/spend" && <Spend />}
            {page === "/todo" && <TodoPage toast={toast} />}
            {page === "/boxes" &&
              (boxId ? <BoxPage key={boxId} id={Number(boxId)} /> : <BoxesPage />)}
            {reading && (
              <Reader
                key={params.toString()}
                path={params.get("path") ?? ""}
                file={Number(params.get("file")) || 0}
              />
            )}
            {page === "/settings" && <Settings path={path} toast={toast} onSignOut={onSignOut} />}
          </Suspense>
          {page === "/search" && <Search query={params.get("q") ?? ""} />}
        </main>

        {insp && wide && view.path !== "/live" && (
          <aside className="inspector">
            <div className="insp-head">
              <h2>Live</h2>
              <span className="spacer" />
              <button type="button" className="tb-btn" onClick={toggleInsp} title="Close">
                <Icon name="x" />
              </button>
            </div>
            <div className="insp-body">
              <LiveView />
            </div>
          </aside>
        )}
      </div>

      <nav className="tabbar" aria-label="Sections">
        {VIEWS.filter((v) => v.phone).map((v) => (
          <button
            type="button"
            key={v.path}
            className={v.path === (TAB_OF[view.path] ?? view.path) ? "active" : ""}
            onClick={() => navigate(v.path)}
          >
            <Icon name={v.icon} />
            {v.title}
            {v.path === "/tasks" && pending > 0 && <span className="badge">{pending}</span>}
            {v.path === "/" && unread > 0 && <span className="badge unread">{unread}</span>}
          </button>
        ))}
      </nav>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => {
          const icon = TOAST_ICON[t.kind];
          return (
            <div className={`toast ${t.kind}`} key={t.id}>
              {icon && <Icon name={icon} />}
              {t.text}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** While paused, schedules and watchers still look on; their runs are skipped. */
export function PausedBanner() {
  const paused = useStore((s) => s.paused);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!paused) return null;
  const resume = () => {
    setBusy(true);
    setError("");
    setPaused(false)
      .catch((err) => setError(errorText(err, "Couldn't resume.")))
      .finally(() => setBusy(false));
  };
  return (
    <div className="paused-banner offline-banner">
      <Icon name="pause" />
      {error ? `All activity is paused. ${error}` : "All activity is paused."}
      <span className="spacer" />
      <button type="button" className="btn sm" disabled={busy} onClick={resume}>
        Resume
      </button>
    </div>
  );
}

function ChatNav({
  current,
  path,
  onPick,
}: {
  current: number;
  path: string;
  onPick?: () => void;
}) {
  const chats = useStore((s) => s.conversations);
  const manyBots = useStore((s) => s.botIds.length > 1);
  const item = (to: string, lit: boolean, icon: ReactNode, name: string, unread = 0) => (
    <button
      type="button"
      key={to}
      className={`nav-item ${lit ? "active" : ""}`}
      onClick={() => {
        onPick?.();
        navigate(to);
      }}
    >
      {icon}
      <span className="nav-name">{name}</span>
      {unread > 0 && <span className="count unread">{unread}</span>}
    </button>
  );
  return (
    <>
      {chats.map((c) =>
        item(
          chatPath(c.id),
          c.id === current,
          <ChatIcon chat={c} />,
          chatName(getState(), c),
          c.unread,
        ),
      )}
      {!chats.length && item("/", current > 0, <Icon name="chat" />, "Chat")}
      {item("/bots/new", path === "/bots/new", <Icon name="plus" />, "New bot")}
      {manyBots && item("/groups/new", path === "/groups/new", <Icon name="users" />, "New group")}
    </>
  );
}

function ChatIcon({ chat }: { chat: Conversation }) {
  const bot = useStore((s) => (chat.kind === "direct" ? s.bots[chat.botIds[0] ?? ""] : undefined));
  if (bot) return <BotMark bot={bot} />;
  return <Icon name={chat.kind === "group" ? "users" : "chat"} />;
}
