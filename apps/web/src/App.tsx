import type { Conversation, Me } from "@hatbot/shared";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, errorText } from "./api";
import { BotMark, Icon, type IconName } from "./icons";
import { Link } from "./link";
import { LiveView } from "./live";
import { BotPage } from "./pages/Bot";
import { Chat } from "./pages/Chat";
import { GroupPage } from "./pages/Group";
import { Login, Setup } from "./pages/Login";
import { Search } from "./pages/Search";
import { TaskDetail, Tasks } from "./pages/Tasks";
import { navigate, useRoute } from "./router";
import { focusable, moveFocus, useRoving } from "./roving";
import {
  chatName,
  chatPath,
  connect,
  currentChat,
  disconnect,
  getState,
  HATBOT_CHAT,
  loadApproval,
  loadConversation,
  loadNegotiations,
  needsYou,
  negotiationOf,
  onToast,
  reconnectNow,
  setIncognito,
  setPaused,
  threadNeedsYou,
  threadPath,
  unreadCount,
  useStore,
} from "./store";
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
  { path: "/", title: "Chat" },
  { path: "/tasks", title: "Tasks" },
  { path: "/live", title: "Live" },
  { path: "/schedules", title: "Automations" },
  { path: "/memory", title: "Memory" },
  { path: "/todo", title: "To-do" },
  { path: "/boxes", title: "Boxes" },
  { path: "/search", title: "Search" },
  { path: "/settings", title: "Settings" },
  { path: "/spend", title: "Spend" },
] as const;
type View = (typeof VIEWS)[number];
type ViewPath = View["path"];

/** The rail's and the tab bar's entries (Search is in the top bar). One with more than one view shows
    them as tabs. */
const SECTIONS = [
  { views: ["/"], title: "Chat", icon: "chat", phone: true },
  { views: ["/tasks", "/live", "/schedules"], title: "Tasks", icon: "tasks", phone: true },
  { views: ["/memory", "/todo"], title: "Memory", icon: "book", phone: true },
  { views: ["/boxes"], title: "Boxes", icon: "box", phone: false },
  { views: ["/search"], title: "Search", icon: "search", phone: false },
  { views: ["/settings", "/spend"], title: "Settings", icon: "sliders", phone: true },
] as const satisfies readonly {
  views: readonly ViewPath[];
  title: string;
  icon: IconName;
  phone: boolean;
}[];
type Section = (typeof SECTIONS)[number];
const sectionOf = (v: View): Section =>
  SECTIONS.find((s) => (s.views as readonly string[]).includes(v.path)) ?? SECTIONS[0];
const titleOf = (path: string) => VIEWS.find((v) => v.path === path)?.title ?? "";

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
/** On a phone, Boxes is reached from Settings, so its tab stays lit. */
const TAB_OF: Partial<Record<Section["title"], Section["title"]>> = { Boxes: "Settings" };

/** Sub-pages that have a name of their own; anything else is named by its view. */
const SUB_TITLE: Record<string, string> = {
  "/settings/plugins": "Plugins",
  "/settings/notifications": "ntfy server",
  "/settings/api-key": "Anthropic API key",
  "/settings/allowed": "Always allowed",
  "/settings/safety": "Approvals and guardrails",
  "/settings/account": "Password and authenticator",
  "/settings/devices": "Devices and tokens",
  "/settings/checks": "Check everything",
  "/schedules/heartbeat": "Heartbeat",
  "/schedules/new": "New schedule",
  "/watchers/new": "New watcher",
  "/triggers/new": "New trigger",
};

function subTitle(s: ReturnType<typeof getState>, path: string) {
  if (SUB_TITLE[path]) return SUB_TITLE[path];
  const plugin = /^\/settings\/plugins\/([a-z0-9]+)$/.exec(path)?.[1];
  if (plugin) return s.plugins[plugin]?.name;
  const m = /^\/(schedules|triggers|watchers)\/(\d+)$/.exec(path);
  if (m) return s[m[1] as "schedules" | "triggers" | "watchers"][Number(m[2])]?.name;
}

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
  const pending = useStore(needsYou);
  const unread = useStore(unreadCount);
  const incognito = useStore((s) => s.incognito);
  const chats = useStore((s) => s.conversations);
  const chat = useStore(currentChat);
  const title = useStore((s) => chatName(s, currentChat(s)));
  const openThreads = useStore(
    (s) =>
      Object.values(s.threads).filter((t) => t.parentId === s.conversationId && !t.resolvedAt)
        .length,
  );
  const threadsNeedYou = useStore((s) =>
    Object.values(s.threads).some((t) => t.parentId === s.conversationId && threadNeedsYou(s, t)),
  );
  const [chatMenu, setChatMenu] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const manyBots = useStore((s) => s.botIds.length > 1);
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
  const sidebar = useRef<HTMLElement>(null);
  useRoving(sidebar, ".nav .nav-item", "y");
  const main = useRef<HTMLElement>(null);
  const connected = useStore((s) => s.connected);
  // A blip while reconnecting isn't worth a banner.
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (connected) return setDown(false);
    const t = setTimeout(() => setDown(true), 4000);
    return () => clearTimeout(t);
  }, [connected]);
  const [toasts, setToasts] = useState<
    { id: number; text: string; kind: ToastKind; leaving?: boolean }[]
  >([]);
  // The reader is Memory's for a note; an attachment's stays with the view it was opened from.
  const reading = path === "/read";
  const openedFrom = useRef<View>(VIEWS[0]);
  const view = reading && !params.get("path") ? openedFrom.current : viewOf(path);
  if (!reading) openedFrom.current = view;
  const page = reading ? "" : view.path;
  const section = sectionOf(view);
  const tab = TAB_OF[section.title] ?? section.title;
  const tabs = section.views.length > 1 && (section.views as readonly string[]).includes(path);
  // The side panel is hidden on a phone; it isn't drawn either, or its live view would stream unseen.
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
              subTitle(s, path) ??
              view.title),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every navigation
  useEffect(() => {
    setChatMenu(false);
    setNewMenu(false);
  }, [path]);
  // A page that took away what had the focus starts it at its own top, not back in the sidebar.
  const route = path + params.toString();
  const shownRoute = useRef(route);
  useEffect(() => {
    if (shownRoute.current === route) return;
    shownRoute.current = route;
    if (!document.activeElement || document.activeElement === document.body)
      main.current?.focus({ preventScroll: true });
  }, [route]);
  // Up and down go through a page's lists of links, as through the sidebar.
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const ROWS = ".row-link, .row-main, .link-row a";
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).matches(ROWS)) moveFocus(e, focusable(el, ROWS), "y", false);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  // A thread opens beside its chat. One that's gone, e.g. a deleted bot's: back to Hatbot's.
  const message = params.get("message");
  useEffect(() => {
    if (!chatId || !chats.length || chats.some((c) => c.id === chatId)) return;
    loadConversation(chatId).then(
      (c) =>
        navigate(
          c.kind === "thread" ? `${threadPath(c)}${message ? `&message=${message}` : ""}` : "/",
          true,
        ),
      () => navigate("/", true),
    );
  }, [chatId, chats, message]);

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
    setTimeout(
      () => setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x))),
      2600,
    );
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

  // Cmd/Ctrl-K: Search. Alt-Up and Alt-Down: the chat above or below. Escape: closes the chat
  // switcher or the New menu.
  const onChat = chatId || pageChat?.id || 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        onChat &&
        !t?.closest("canvas, .live-keys")
      ) {
        const i = chats.findIndex((c) => c.id === onChat);
        const next = chats[i + (e.key === "ArrowUp" ? -1 : 1)];
        e.preventDefault();
        if (i >= 0 && next) navigate(chatPath(next.id));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (location.pathname === "/search")
          document.querySelector<HTMLInputElement>(".search-box input")?.focus();
        else navigate("/search");
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (chatMenu) return setChatMenu(false);
      if (newMenu) setNewMenu(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [chatMenu, newMenu, chats, onChat]);

  return (
    <>
      <div className="app">
        <aside className="sidebar" ref={sidebar}>
          <div className="brand">
            <div className="brand-mark">
              <Icon name="hat" />
            </div>
            <div className="brand-name">Hatbot</div>
            <span className="spacer" />
            {manyBots ? (
              <button
                type="button"
                className={`tb-btn ${newMenu ? "on" : ""}`}
                aria-expanded={newMenu}
                onClick={() => setNewMenu((v) => !v)}
                title="New"
              >
                <Icon name="plus" />
              </button>
            ) : (
              <Link className="tb-btn" to="/bots/new" title="New bot">
                <Icon name="plus" />
              </Link>
            )}
            {newMenu && <NewMenu onClose={() => setNewMenu(false)} />}
          </div>
          <nav className="nav">
            <ChatNav current={chatId || pageChat?.id || 0} path={path} about />
          </nav>
          <nav className="nav nav-views">
            {SECTIONS.filter((s) => s.title !== "Chat" && s.title !== "Search").map((s) => (
              <Link
                key={s.title}
                className={`nav-item ${s === section ? "active" : ""}`}
                aria-current={s === section ? "page" : undefined}
                to={s.views[0]}
              >
                <Icon name={s.icon} filled={s === section} />
                <span>{s.title}</span>
                {s.title === "Tasks" && pending > 0 && (
                  <span className="count attn">{pending}</span>
                )}
              </Link>
            ))}
          </nav>
        </aside>

        <main className="main" ref={main} tabIndex={-1}>
          <header className="toolbar">
            {chatId ? (
              <div className="tb-title">
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
                {chat && chatId > 0 && (
                  <Link className="tb-btn tb-about" to={aboutPath(chat)} title={`About ${title}`}>
                    <Icon name="sliders" />
                  </Link>
                )}
              </div>
            ) : tabs ? (
              <SectionTabs label={section.title} views={section.views} path={path} />
            ) : (
              <h1>{pageTitle}</h1>
            )}
            <span className="spacer" />
            {chatId > 0 && chat?.kind === "direct" && (
              <Link
                className={`tb-btn ${params.has("thread") || params.has("threads") ? "on" : ""}`}
                to={
                  params.has("thread") || params.has("threads")
                    ? chatPath(chatId)
                    : `${chatPath(chatId)}?threads`
                }
                title="Threads"
              >
                <Icon name="forum" />
                {openThreads > 0 && (
                  <span className={`tnum ${threadsNeedYou ? "attn" : ""}`}>{openThreads}</span>
                )}
              </Link>
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
            <Link
              className={`tb-btn ${view.path === "/search" ? "on" : ""}`}
              to="/search"
              title="Search"
            >
              <Icon name="search" />
            </Link>
          </header>
          {down && (
            <div className="banner offline-banner">
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
              <ChatNav current={chatId} path={path} onPick={() => setChatMenu(false)} withNew />
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
            {page === "/schedules" && <SchedulesView path={path} params={params} toast={toast} />}
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
      </div>

      <nav className="tabbar" aria-label="Sections">
        {SECTIONS.filter((s) => s.phone).map((s) => (
          <Link key={s.title} className={s.title === tab ? "active" : ""} to={s.views[0]}>
            <Icon name={s.icon} filled={s.title === tab} />
            {s.title}
            {s.title === "Tasks" && pending > 0 && <span className="badge">{pending}</span>}
            {s.title === "Chat" && unread > 0 && <span className="badge unread">{unread}</span>}
          </Link>
        ))}
      </nav>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => {
          const icon = TOAST_ICON[t.kind];
          return (
            <div className={`toast ${t.kind} ${t.leaving ? "leaving" : ""}`} key={t.id}>
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
    <div className="banner offline-banner">
      <Icon name="pause" />
      {error ? `All activity is paused. ${error}` : "All activity is paused."}
      <span className="spacer" />
      <button type="button" className="btn sm" disabled={busy} onClick={resume}>
        Resume
      </button>
    </div>
  );
}

function SectionTabs({
  label,
  views,
  path,
}: {
  label: string;
  views: readonly string[];
  path: string;
}) {
  const el = useRef<HTMLElement>(null);
  useRoving(el, "a", "x");
  return (
    <nav className="tabs" aria-label={label} ref={el}>
      {views.map((v) => (
        <Link key={v} className={v === path ? "active" : ""} to={v}>
          {titleOf(v)}
        </Link>
      ))}
    </nav>
  );
}

/** New bot and New group, from the + by Hatbot's name. */
function NewMenu({ onClose }: { onClose: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  useRoving(el, ".nav-item", "y");
  // It opens on its first item, and Escape goes back to the +.
  useEffect(() => el.current?.querySelector<HTMLElement>(".nav-item")?.focus(), []);
  useEffect(() => {
    const menu = el.current;
    if (!menu) return;
    const toggle = () => document.querySelector<HTMLElement>(".brand [aria-expanded]");
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      toggle()?.focus();
    };
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && !menu.contains(to) && !toggle()?.contains(to)) onClose();
    };
    menu.addEventListener("keydown", onKey);
    menu.addEventListener("focusout", onOut);
    return () => {
      menu.removeEventListener("keydown", onKey);
      menu.removeEventListener("focusout", onOut);
    };
  }, [onClose]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // The + itself toggles it.
      const t = e.target as Element;
      if (!el.current?.contains(t) && !t.closest?.(".brand [aria-expanded]")) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);
  return (
    <div className="new-menu" ref={el}>
      <Link className="nav-item" to="/bots/new">
        <Icon name="hat" />
        <span className="nav-name">New bot</span>
      </Link>
      <Link className="nav-item" to="/groups/new">
        <Icon name="users" />
        <span className="nav-name">New group</span>
      </Link>
    </div>
  );
}

function ChatNav({
  current,
  path,
  onPick,
  withNew,
  about,
}: {
  current: number;
  path: string;
  onPick?: () => void;
  /** On a phone, where there's no rail with its +. */
  withNew?: boolean;
  /** Each chat's settings, on hover. */
  about?: boolean;
}) {
  const chats = useStore((s) => s.conversations);
  const manyBots = useStore((s) => s.botIds.length > 1);
  const item = (
    to: string,
    lit: boolean,
    icon: ReactNode,
    name: string,
    unread = 0,
    settings?: string,
  ) => {
    const link = (
      <Link
        key={to}
        className={`nav-item ${lit ? "active" : ""}`}
        aria-current={lit ? "page" : undefined}
        to={to}
        onClick={onPick}
      >
        {icon}
        <span className="nav-name">{name}</span>
        {unread > 0 && <span className="count unread">{unread}</span>}
      </Link>
    );
    if (!settings) return link;
    return (
      <div key={to} className="nav-row">
        {link}
        {/* Not a Tab stop of its own for each chat: the chat's top bar has About too. */}
        <Link className="tb-btn nav-about" to={settings} title={`About ${name}`} tabIndex={-1}>
          <Icon name="sliders" />
        </Link>
      </div>
    );
  };
  return (
    <>
      {chats.map((c) =>
        item(
          chatPath(c.id),
          c.id === current,
          <ChatIcon chat={c} filled={c.id === current} />,
          chatName(getState(), c),
          c.unread,
          about ? aboutPath(c) : undefined,
        ),
      )}
      {!chats.length && item("/", current > 0, <Icon name="chat" filled={current > 0} />, "Chat")}
      {withNew && item("/bots/new", path === "/bots/new", <Icon name="plus" />, "New bot")}
      {withNew &&
        manyBots &&
        item(
          "/groups/new",
          path === "/groups/new",
          <Icon name="users" filled={path === "/groups/new"} />,
          "New group",
        )}
    </>
  );
}

const aboutPath = (c: Conversation) =>
  c.kind === "group" ? `/groups/${c.id}` : `/bots/${c.botIds[0]}`;

function ChatIcon({ chat, filled }: { chat: Conversation; filled: boolean }) {
  const bot = useStore((s) => (chat.kind === "direct" ? s.bots[chat.botIds[0] ?? ""] : undefined));
  if (bot) return <BotMark bot={bot} filled={filled} />;
  return <Icon name={chat.kind === "group" ? "users" : "chat"} filled={filled} />;
}
