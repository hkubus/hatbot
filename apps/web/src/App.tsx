import type { Approval, Conversation, Me } from "@hatbot/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { BotMark, Icon, type IconName } from "./icons";
import { LiveView } from "./live";
import { BotPage } from "./pages/Bot";
import { Chat } from "./pages/Chat";
import { GroupPage } from "./pages/Group";
import { Login, Setup } from "./pages/Login";
import { Memory } from "./pages/Memory";
import { SchedulesView } from "./pages/Schedules";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { SkillDraft } from "./pages/SkillDraft";
import { Spend } from "./pages/Spend";
import { TaskDetail, Tasks } from "./pages/Tasks";
import { navigate, useRoute } from "./router";
import {
  chatName,
  connect,
  currentChat,
  disconnect,
  ensureApproval,
  getState,
  HATBOT_CHAT,
  needsYou,
  onToast,
  openConversation,
  setIncognito,
  useStore,
} from "./store";
import { getTheme, setTheme, type Theme } from "./theme";

const VIEWS = [
  { path: "/", title: "Chat", icon: "chat", phone: true },
  { path: "/tasks", title: "Tasks", icon: "tasks", phone: true },
  { path: "/search", title: "Search", icon: "search", phone: false },
  { path: "/live", title: "Live", icon: "monitor", phone: true },
  { path: "/schedules", title: "Schedules & Triggers", icon: "clock", phone: false },
  { path: "/memory", title: "Memory", icon: "book", phone: true },
  { path: "/spend", title: "Spend", icon: "gauge", phone: false },
  { path: "/settings", title: "Settings", icon: "sliders", phone: true },
] as const satisfies readonly { path: string; title: string; icon: IconName; phone: boolean }[];

const viewOf = (path: string) =>
  VIEWS.find((v) =>
    path.startsWith("/triggers/") || path.startsWith("/watchers/")
      ? v.path === "/schedules"
      : v.path === "/"
        ? path === "/" ||
          path.startsWith("/chat/") ||
          path.startsWith("/bots/") ||
          path.startsWith("/groups/")
        : path === v.path || path.startsWith(`${v.path}/`),
  ) ?? VIEWS[0];

/** Hatbot's chat is the app's front page. */
export const chatPath = (id: number) => (id === HATBOT_CHAT ? "/" : `/chat/${id}`);

function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    window.addEventListener("hatbot:theme", l);
    return () => window.removeEventListener("hatbot:theme", l);
  }, getTheme);
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => {
    api<Me>("/auth/me").then(setMe, () => setMe({ setupDone: true, authenticated: false }));
  }, []);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => setMe((m) => (m ? { ...m, authenticated: false } : m));
    window.addEventListener("hatbot:unauthorized", onUnauthorized);
    return () => window.removeEventListener("hatbot:unauthorized", onUnauthorized);
  }, [refresh]);

  if (!me) return null;
  if (!me.setupDone) return <Setup onDone={refresh} />;
  if (!me.authenticated) return <Login onDone={refresh} />;
  return <Shell onSignOut={refresh} />;
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const { path, params } = useRoute();
  const theme = useTheme();
  const pending = useStore(needsYou);
  const unread = useStore((s) => s.unread.length);
  const incognito = useStore((s) => s.incognito);
  const chats = useStore((s) => s.conversations);
  const chat = useStore(currentChat);
  const title = useStore((s) => chatName(s, currentChat(s)));
  const [chatMenu, setChatMenu] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [insp, setInsp] = useState(() => localStorage.getItem("hatbot:insp") === "1");
  const view = viewOf(path);
  const taskId = /^\/tasks\/(\d+)$/.exec(path)?.[1];
  const teachId = /^\/memory\/teach\/(\d+)$/.exec(path)?.[1];
  const approvalId = Number(params.get("approval"));
  const botPage = /^\/bots\/([a-z0-9-]+)$/.exec(path)?.[1];
  const groupPage = /^\/groups\/(new|\d+)$/.exec(path)?.[1];
  const manyBots = useStore((s) => s.botIds.length > 1);
  const chatId = path === "/" ? HATBOT_CHAT : Number(/^\/chat\/(\d+)$/.exec(path)?.[1] ?? 0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every navigation
  useEffect(() => setChatMenu(false), [path]);
  // The chat in the address is the one showing.
  useEffect(() => {
    if (chatId) void openConversation(chatId);
  }, [chatId]);
  // One that's gone, e.g. a deleted bot's: back to Hatbot's.
  useEffect(() => {
    if (chatId && chats.length && !chats.some((c) => c.id === chatId)) navigate("/", true);
  }, [chatId, chats]);

  // An approval notification opens /?approval=<id>: show it on its task.
  useEffect(() => {
    if (!approvalId) return;
    ensureApproval(approvalId);
    api<Approval>(`/approvals/${approvalId}`).then(
      (a) => navigate(a.taskId ? `/tasks/${a.taskId}` : "/", true),
      () => navigate("/", true),
    );
  }, [approvalId]);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);

  useEffect(() => {
    onToast(toast);
    connect();
    return disconnect;
  }, [toast]);

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
            {chats.map((c) => (
              <button
                type="button"
                key={c.id}
                className={`nav-item ${chatId === c.id ? "active" : ""}`}
                onClick={() => navigate(chatPath(c.id))}
              >
                <ChatIcon chat={c} />
                <span className="nav-name">{chatName(getState(), c)}</span>
                {c.unread > 0 && <span className="count unread">{c.unread}</span>}
              </button>
            ))}
            {!chats.length && (
              <button
                type="button"
                className={`nav-item ${chatId ? "active" : ""}`}
                onClick={() => navigate("/")}
              >
                <Icon name="chat" />
                <span>Chat</span>
              </button>
            )}
            <button
              type="button"
              className={`nav-item ${botPage === "new" ? "active" : ""}`}
              onClick={() => navigate("/bots/new")}
            >
              <Icon name="plus" />
              <span>New bot</span>
            </button>
            {manyBots && (
              <button
                type="button"
                className={`nav-item ${groupPage === "new" ? "active" : ""}`}
                onClick={() => navigate("/groups/new")}
              >
                <Icon name="users" />
                <span>New group</span>
              </button>
            )}
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
                  type="button"
                  className="chat-switch show-phone-inline"
                  onClick={() => setChatMenu((v) => !v)}
                >
                  <h1>{incognito ? `${title} · Incognito` : title}</h1>
                  <Icon name="chevron" />
                </button>
              </>
            ) : (
              <h1>
                {botPage
                  ? botPage === "new"
                    ? "New bot"
                    : "Bot"
                  : groupPage
                    ? groupPage === "new"
                      ? "New group"
                      : "Group"
                    : view.title}
              </h1>
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
          {chatMenu && chatId > 0 && (
            <div className="chat-menu">
              {chats.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={c.id === chatId ? "on" : ""}
                  onClick={() => {
                    setChatMenu(false);
                    navigate(chatPath(c.id));
                  }}
                >
                  <span className="name">{chatName(getState(), c)}</span>
                  {c.unread > 0 && <span className="badge unread">{c.unread}</span>}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setChatMenu(false);
                  navigate("/bots/new");
                }}
              >
                <span className="name">New bot</span>
              </button>
              {manyBots && (
                <button
                  type="button"
                  onClick={() => {
                    setChatMenu(false);
                    navigate("/groups/new");
                  }}
                >
                  <span className="name">New group</span>
                </button>
              )}
            </div>
          )}
          {chatId > 0 && <Chat key={chatId} />}
          {botPage && <BotPage key={botPage} id={botPage} toast={toast} />}
          {groupPage && <GroupPage key={groupPage} id={groupPage} toast={toast} />}
          {view.path === "/tasks" &&
            (taskId ? (
              <TaskDetail key={taskId} id={Number(taskId)} live={params.get("live") === "1"} />
            ) : (
              <Tasks />
            ))}
          {view.path === "/live" && (
            <section className="view">
              <div className="page narrow">
                <LiveView />
              </div>
            </section>
          )}
          {view.path === "/schedules" && <SchedulesView path={path} params={params} />}
          {view.path === "/memory" &&
            (teachId ? (
              <SkillDraft key={teachId} id={Number(teachId)} toast={toast} />
            ) : (
              <Memory
                key={params.get("path") ?? ""}
                toast={toast}
                open={params.get("path") ?? ""}
              />
            ))}
          {view.path === "/spend" && <Spend />}
          {view.path === "/search" && <Search query={params.get("q") ?? ""} />}
          {view.path === "/settings" && (
            <Settings path={path} toast={toast} onSignOut={onSignOut} />
          )}
        </main>

        {insp && view.path !== "/live" && (
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
            className={
              v === view ||
              (v.path === "/settings" && (view.path === "/spend" || view.path === "/schedules"))
                ? "active"
                : ""
            }
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
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <Icon name="check" />
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

/** A bot's own chat goes by its icon; a group by the group icon. */
function ChatIcon({ chat }: { chat: Conversation }) {
  const bot = useStore((s) => (chat.kind === "direct" ? s.bots[chat.botIds[0] ?? ""] : undefined));
  if (bot) return <BotMark bot={bot} />;
  return <Icon name={chat.kind === "group" ? "users" : "chat"} />;
}
