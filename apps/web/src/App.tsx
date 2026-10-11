import type { Approval, Me } from "@hatbot/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { Icon, type IconName } from "./icons";
import { LiveView } from "./live";
import { Chat } from "./pages/Chat";
import { Login, Setup } from "./pages/Login";
import { Memory } from "./pages/Memory";
import { SchedulesView } from "./pages/Schedules";
import { Settings } from "./pages/Settings";
import { SkillDraft } from "./pages/SkillDraft";
import { Spend } from "./pages/Spend";
import { TaskDetail, Tasks } from "./pages/Tasks";
import { navigate, useRoute } from "./router";
import { connect, disconnect, ensureApproval, needsYou, onToast, useStore } from "./store";
import { getTheme, setTheme, type Theme } from "./theme";

const VIEWS = [
  { path: "/", title: "Chat", icon: "chat", phone: true },
  { path: "/tasks", title: "Tasks", icon: "tasks", phone: true },
  { path: "/live", title: "Live", icon: "monitor", phone: true },
  { path: "/schedules", title: "Schedules & Triggers", icon: "clock", phone: false },
  { path: "/memory", title: "Memory", icon: "book", phone: true },
  { path: "/spend", title: "Spend", icon: "gauge", phone: false },
  { path: "/settings", title: "Settings", icon: "sliders", phone: true },
] as const satisfies readonly { path: string; title: string; icon: IconName; phone: boolean }[];

const viewOf = (path: string) =>
  VIEWS.find((v) =>
    path.startsWith("/triggers/")
      ? v.path === "/schedules"
      : v.path === "/"
        ? path === "/"
        : path === v.path || path.startsWith(`${v.path}/`),
  ) ?? VIEWS[0];

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
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [insp, setInsp] = useState(() => localStorage.getItem("hatbot:insp") === "1");
  const view = viewOf(path);
  const taskId = /^\/tasks\/(\d+)$/.exec(path)?.[1];
  const teachId = /^\/memory\/teach\/(\d+)$/.exec(path)?.[1];
  const approvalId = Number(params.get("approval"));

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
            {VIEWS.map((v) => (
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
                {v.path === "/" && unread > 0 && <span className="count unread">{unread}</span>}
              </button>
            ))}
          </nav>
        </aside>

        <main className="main">
          <header className="toolbar">
            <h1>{view.title}</h1>
            <span className="spacer" />
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
          {view.path === "/" && <Chat />}
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
