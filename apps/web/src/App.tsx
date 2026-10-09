import type { Me } from "@hatbot/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { Icon, type IconName } from "./icons";
import { Chat } from "./pages/Chat";
import { Login, Setup } from "./pages/Login";
import { Memory } from "./pages/Memory";
import { Settings } from "./pages/Settings";
import { Spend } from "./pages/Spend";
import { connect, disconnect, onToast, setPaused, useStore } from "./store";
import { getTheme, setTheme, type Theme } from "./theme";

const VIEWS = [
  { path: "/", title: "Chat", icon: "chat" },
  { path: "/memory", title: "Memory", icon: "book" },
  { path: "/spend", title: "Spend", icon: "gauge" },
  { path: "/settings", title: "Settings", icon: "sliders" },
] as const satisfies readonly { path: string; title: string; icon: IconName }[];
type Path = (typeof VIEWS)[number]["path"];

const currentPath = (): Path =>
  (VIEWS.find((v) => v.path === location.pathname)?.path ?? "/") as Path;

function usePath(): [Path, (p: Path) => void] {
  const path = useSyncExternalStore((l) => {
    window.addEventListener("popstate", l);
    return () => window.removeEventListener("popstate", l);
  }, currentPath);
  const go = useCallback((p: Path) => {
    if (p !== location.pathname) history.pushState(null, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  return [path, go];
}

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
  const [path, go] = usePath();
  const theme = useTheme();
  const paused = useStore((s) => s.paused);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const view = VIEWS.find((v) => v.path === path) ?? VIEWS[0];

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
  const togglePause = () =>
    setPaused(!paused).then(
      () => toast(paused ? "Resumed" : "All activity paused"),
      () => toast("Couldn't reach Hatbot"),
    );

  return (
    <>
      <div className="app">
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
                className={`nav-item ${v.path === path ? "active" : ""}`}
                onClick={() => go(v.path)}
              >
                <Icon name={v.icon} />
                <span>{v.title}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="main">
          <header className="toolbar">
            <h1>{view.title}</h1>
            <span className="spacer" />
            <button type="button" className="tb-btn" onClick={cycleTheme} title={`Theme: ${theme}`}>
              <Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "auto"} />
            </button>
            <button
              type="button"
              className={`tb-btn ${paused ? "on" : ""}`}
              onClick={togglePause}
              title={paused ? "Resume" : "Pause all"}
            >
              <Icon name={paused ? "play" : "pause"} />
              <span className="hide-phone">{paused ? "Resume" : "Pause all"}</span>
            </button>
          </header>
          {path === "/" && <Chat />}
          {path === "/memory" && <Memory toast={toast} />}
          {path === "/spend" && <Spend />}
          {path === "/settings" && <Settings toast={toast} onSignOut={onSignOut} />}
        </main>
      </div>

      <nav className="tabbar" aria-label="Sections">
        {VIEWS.map((v) => (
          <button
            type="button"
            key={v.path}
            className={v.path === path ? "active" : ""}
            onClick={() => go(v.path)}
          >
            <Icon name={v.icon} />
            {v.title}
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
