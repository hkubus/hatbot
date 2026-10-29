import { latestNoteOnly, type TaskStep } from "@hatbot/shared";
import type { LiveInput } from "@hatbot/shared/desktop";
import { useEffect, useRef, useState } from "react";
import { errorText } from "./api";
import { ask } from "./confirm";
import { plainText, time } from "./format";
import { Held } from "./held";
import { Icon } from "./icons";
import { navigate } from "./router";
import {
  discardTeach,
  ensureSteps,
  handback,
  openSocket,
  recording,
  startTeach,
  stopTeach,
  takeover,
  useStore,
} from "./store";
import { taskLine } from "./tasks";
import { LinkRow, Seg } from "./ui";

type Conn = "connecting" | "live" | "offline";

type Viewer = { canvas: React.RefObject<HTMLCanvasElement | null>; setConn: (c: Conn) => void };

/** One socket per screen and tab however many views show it. */
const makeFeed = (path: string) => {
  const viewers = new Set<Viewer>();
  let socket: WebSocket | null = null;
  let conn: Conn = "connecting";
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Draw only the newest frame; skip any that arrive while one decodes.
  let decoding = false;
  let next: Blob | null = null;
  // For a screen that opens while the desktop is still: the desktop sends only changes.
  let last: Blob | null = null;
  const held = new Held();

  const status = (c: Conn) => {
    conn = c;
    for (const v of viewers) v.setConn(c);
  };
  const paint = async (blob: Blob, to: Iterable<Viewer>) => {
    try {
      const bmp = await createImageBitmap(blob);
      for (const v of to) {
        const c = v.canvas.current;
        if (!c) continue;
        if (c.width !== bmp.width || c.height !== bmp.height) {
          c.width = bmp.width;
          c.height = bmp.height;
        }
        c.getContext("2d")?.drawImage(bmp, 0, 0);
      }
      bmp.close();
    } catch {
      // A truncated frame; the next one replaces it.
    }
  };
  const draw = async (blob: Blob) => {
    decoding = true;
    await paint(blob, viewers);
    decoding = false;
    if (next) {
      const b = next;
      next = null;
      void draw(b);
    }
  };

  const open = () => {
    const ws = openSocket(path);
    ws.binaryType = "blob";
    socket = ws;
    ws.onopen = () => {
      retry = 0;
      status("live");
    };
    ws.onmessage = (e) => {
      if (!(e.data instanceof Blob)) return;
      last = e.data;
      if (decoding) next = e.data;
      else void draw(e.data);
    };
    ws.onclose = () => {
      // Closed on purpose (hidden, nobody watching): nothing to retry.
      if (socket !== ws) return;
      socket = null;
      status("offline");
      timer = setTimeout(open, Math.min(15_000, 1000 * 2 ** retry++));
    };
  };
  /** Lets go of what's held down on the desktop, while the socket is still there to say so. */
  const release = () => {
    for (const m of held.ups())
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
  };
  const close = () => {
    release();
    clearTimeout(timer);
    const ws = socket;
    socket = null;
    ws?.close();
  };
  // No frames for a tab nobody's looking at; back on when it's visible again.
  const onVisibility = () => {
    if (document.hidden) return close();
    if (socket) return;
    retry = 0;
    status("connecting");
    open();
  };

  return {
    join(v: Viewer) {
      viewers.add(v);
      if (viewers.size === 1) {
        document.addEventListener("visibilitychange", onVisibility);
        status("connecting");
        if (!document.hidden) open();
      } else {
        v.setConn(conn);
        if (last) void paint(last, [v]);
      }
      return () => {
        viewers.delete(v);
        if (viewers.size) return;
        document.removeEventListener("visibilitychange", onVisibility);
        close();
        last = next = null;
      };
    },
    send(m: LiveInput) {
      if (socket?.readyState !== WebSocket.OPEN) return;
      held.note(m);
      socket.send(JSON.stringify(m));
    },
    release,
  };
};

type Feed = ReturnType<typeof makeFeed>;
const feeds = new Map<string, Feed>();
const feedOf = (screen: string | null) => {
  const path = screen ? `/computer/live/${encodeURIComponent(screen)}` : "/desktop/live";
  let f = feeds.get(path);
  if (!f) {
    f = makeFeed(path);
    feeds.set(path, f);
  }
  return f;
};

function useFrames(canvas: React.RefObject<HTMLCanvasElement | null>, feed: Feed) {
  const [conn, setConn] = useState<Conn>("connecting");
  useEffect(() => feed.join({ canvas, setConn }), [canvas, feed]);
  return { conn, send: feed.send };
}

const BUTTONS: Record<number, 1 | 2 | 3> = { 0: 1, 1: 2, 2: 3 };

function Screen({ control, feed, name }: { control: boolean; feed: Feed; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef<HTMLInputElement>(null);
  const { conn, send } = useFrames(canvas, feed);
  const lastMove = useRef(0);
  // Keys and buttons held when the view loses them (another window, a hidden tab, Hand back, leaving the
  // page) are let go of, or they'd stay held on the desktop.
  useEffect(() => {
    if (!control) return;
    window.addEventListener("blur", feed.release);
    return () => {
      window.removeEventListener("blur", feed.release);
      feed.release();
    };
  }, [control, feed]);
  // Wheel events come by the dozen; they're added up and sent every 100 ms.
  const wheel = useRef<{ dx: number; dy: number; x: number; y: number } | null>(null);

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  };
  const key = (k: string) => {
    send({ t: "key", key: k, down: true });
    send({ t: "key", key: k, down: false });
  };

  const handlers = control
    ? {
        onPointerMove: (e: React.PointerEvent) => {
          const now = performance.now();
          if (now - lastMove.current < 50) return;
          lastMove.current = now;
          send({ t: "move", ...point(e) });
        },
        onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
          const button = BUTTONS[e.button];
          if (!button) return;
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          send({ t: "button", button, down: true, ...point(e) });
        },
        onPointerUp: (e: React.PointerEvent) => {
          const button = BUTTONS[e.button];
          if (button) send({ t: "button", button, down: false, ...point(e) });
        },
        onPointerCancel: feed.release,
        onBlur: feed.release,
        onWheel: (e: React.WheelEvent) => {
          const at = point(e);
          const w = wheel.current;
          if (w) {
            Object.assign(w, { dx: w.dx + e.deltaX, dy: w.dy + e.deltaY, ...at });
            return;
          }
          wheel.current = { dx: e.deltaX, dy: e.deltaY, ...at };
          setTimeout(() => {
            const sum = wheel.current;
            wheel.current = null;
            if (sum) send({ t: "wheel", ...sum });
          }, 100);
        },
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.nativeEvent.isComposing) return;
          e.preventDefault();
          send({ t: "key", key: e.key, down: true });
        },
        onKeyUp: (e: React.KeyboardEvent) => {
          e.preventDefault();
          send({ t: "key", key: e.key, down: false });
        },
      }
    : {};

  return (
    <>
      <div className={`screen ${control ? "control" : ""}`}>
        <canvas
          ref={canvas}
          width={1280}
          height={800}
          tabIndex={control ? 0 : -1}
          aria-label={name}
          {...handlers}
        />
        {conn !== "live" && (
          <div className="screen-note">
            {conn === "connecting" ? "Connecting…" : `${name} isn't answering.`}
          </div>
        )}
      </div>
      {control && (
        // Phones have no keyboard for a canvas: this field opens one and forwards what you type.
        <input
          ref={keyboard}
          className="live-keys"
          aria-label={`Type on ${name}`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onBeforeInput={(e) => {
            const ev = e.nativeEvent as InputEvent;
            e.preventDefault();
            if (ev.inputType === "deleteContentBackward") key("Backspace");
            else if (ev.inputType === "insertLineBreak") key("Enter");
            else for (const ch of ev.data ?? "") key(ch);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" || e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              key(e.key);
            }
          }}
        />
      )}
      {control && (
        <div className="live-controls keys-btn">
          <button type="button" className="btn" onClick={() => keyboard.current?.focus()}>
            <Icon name="keyboard" />
            Keyboard
          </button>
        </div>
      )}
    </>
  );
}

const STEP_ICON: Record<TaskStep["kind"], Parameters<typeof Icon>[0]["name"]> = {
  note: "chat",
  action: "pointer",
  screenshot: "monitor",
  page: "globe",
  approval: "shield",
  takeover: "hand",
  error: "alert",
  task: "monitor",
};

export function StepIcon({ kind, name }: { kind: TaskStep["kind"]; name?: string }) {
  if (kind === "action" && name?.startsWith("memory_")) return <Icon name="book" />;
  if (kind === "action" && name === "search_history") return <Icon name="chat" />;
  return <Icon name={STEP_ICON[kind]} />;
}

export function LiveView({ taskId }: { taskId?: number }) {
  const desktop = useStore((s) => s.desktop);
  const computers = useStore((s) => s.computers);
  const given = useStore((s) => (taskId ? s.tasks[taskId] : undefined));
  const teach = useStore(recording);
  const [picked, setPicked] = useState<string | null>(null);
  // A task's view shows its own screen; otherwise you pick one.
  const screen = taskId
    ? (given?.screen ?? null)
    : !teach && computers.some((c) => c.id === picked)
      ? picked
      : null;
  const machine = screen ? computers.find((c) => c.id === screen) : undefined;
  const on = screen ? machine : desktop;
  const name = machine?.name ?? "The desktop";
  const feed = feedOf(screen);
  const activeId = taskId ?? on?.activeTaskId ?? on?.request?.taskId ?? null;
  const task = useStore((s) => (activeId ? s.tasks[activeId] : undefined));
  const steps = useStore((s) => (activeId ? s.steps[activeId] : undefined));
  const progress = useStore((s) => (activeId ? s.taskProgress[activeId] : undefined));
  const [error, setError] = useState("");
  useEffect(() => {
    if (activeId) ensureSteps(activeId);
  }, [activeId]);

  const control = on?.control === "owner";
  // Not a computer you're not using: only during a task.
  const canTakeOver = !machine || machine.activeTaskId !== null;
  const run = (fn: () => Promise<void>) => {
    setError("");
    fn().catch((err) => setError(errorText(err)));
  };
  // Before control goes back: after it, the brain no longer passes your input on.
  const giveBack = (fn: () => Promise<void>) =>
    run(() => {
      feed.release();
      return fn();
    });

  const stop = () =>
    giveBack(async () => {
      const s = await stopTeach();
      navigate(`/memory/teach/${s.id}`);
    });
  const discard = async (id: number) => {
    if (await ask({ text: "Discard this recording?", ok: "Discard" }))
      giveBack(() => discardTeach(id));
  };

  return (
    <div className="live">
      {teach ? (
        <div className="banner">
          <Icon name="teach" />
          Recording. Show Hatbot how.
          <div className="actions">
            <button type="button" className="btn sm danger-text" onClick={() => discard(teach.id)}>
              Discard
            </button>
            <button type="button" className="btn sm accent" onClick={stop}>
              Stop and make a skill
            </button>
          </div>
        </div>
      ) : control ? (
        <div className="banner">
          <Icon name="hand" />
          You're in control. Hatbot is paused.
          <span className="spacer" />
          <button
            type="button"
            className="btn sm accent"
            onClick={() => giveBack(() => handback(screen))}
          >
            Hand back
          </button>
        </div>
      ) : on?.request ? (
        <div className="banner attn">
          <Icon name="hand" />
          <div>
            <b>Hatbot needs you:</b> {on.request.reason}
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm primary"
            onClick={() => run(() => takeover(screen))}
          >
            Take over
          </button>
        </div>
      ) : null}
      {!taskId && !teach && computers.length > 0 && (
        <Seg
          value={screen ?? ""}
          options={[["", "Desktop"], ...computers.map((c) => [c.id, c.name] as const)]}
          onChange={(v) => setPicked(v || null)}
        />
      )}
      {on && !on.online ? (
        <div className="screen">
          <div className="screen-note">{name} isn't answering.</div>
        </div>
      ) : (
        <Screen key={screen ?? ""} control={control} feed={feed} name={name} />
      )}
      {!control && !on?.request && on?.online && canTakeOver && (
        <div className="live-controls">
          <button
            type="button"
            className="btn tint-attn"
            onClick={() => run(() => takeover(screen))}
          >
            <Icon name="hand" />
            Take over
          </button>
          {!task && !machine && (
            <button type="button" className="btn" onClick={() => run(() => startTeach())}>
              <Icon name="teach" />
              Teach a skill
            </button>
          )}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      {task && (
        <div className="panel">
          <LinkRow className="live-task" to={`/tasks/${task.id}`} label={task.title} />
          <div className="label">{taskLine(task, progress)}</div>
          {steps && steps.length > 0 && (
            <ul className="log">
              {latestNoteOnly(steps)
                .slice(-6)
                .reverse()
                .map((s) => (
                  <li key={s.id}>
                    <span className="t">{time(s.createdAt)}</span>
                    <StepIcon kind={s.kind} />
                    <span>
                      {s.kind === "note" ? plainText(s.detail || s.name) : s.detail || s.name}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
