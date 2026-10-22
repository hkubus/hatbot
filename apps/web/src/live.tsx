import { latestNoteOnly, type TaskStep } from "@hatbot/shared";
import type { LiveInput } from "@hatbot/shared/desktop";
import { useEffect, useRef, useState } from "react";
import { errorText } from "./api";
import { ask } from "./confirm";
import { plainText, time } from "./format";
import { Held } from "./held";
import { Icon } from "./icons";
import { Link } from "./link";
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

type Conn = "connecting" | "live" | "offline";

type Viewer = { canvas: React.RefObject<HTMLCanvasElement | null>; setConn: (c: Conn) => void };

/** One socket per tab however many screens show it: the inspector beside a task's page, say. */
const feed = (() => {
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
    const ws = openSocket("/desktop/live");
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
})();

function useFrames(canvas: React.RefObject<HTMLCanvasElement | null>) {
  const [conn, setConn] = useState<Conn>("connecting");
  useEffect(() => feed.join({ canvas, setConn }), [canvas]);
  return { conn, send: feed.send };
}

const BUTTONS: Record<number, 1 | 2 | 3> = { 0: 1, 1: 2, 2: 3 };

function Screen({ control }: { control: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef<HTMLInputElement>(null);
  const { conn, send } = useFrames(canvas);
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
  }, [control]);
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
          aria-label="The desktop"
          {...handlers}
        />
        {conn !== "live" && (
          <div className="screen-note">
            {conn === "connecting" ? "Connecting…" : "The desktop isn't answering."}
          </div>
        )}
      </div>
      {control && (
        // Phones have no keyboard for a canvas: this field opens one and forwards what you type.
        <input
          ref={keyboard}
          className="live-keys"
          aria-label="Type on the desktop"
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
  const activeId = taskId ?? desktop?.activeTaskId ?? desktop?.request?.taskId ?? null;
  const task = useStore((s) => (activeId ? s.tasks[activeId] : undefined));
  const steps = useStore((s) => (activeId ? s.steps[activeId] : undefined));
  const progress = useStore((s) => (activeId ? s.taskProgress[activeId] : undefined));
  const teach = useStore(recording);
  const [error, setError] = useState("");
  useEffect(() => {
    if (activeId) ensureSteps(activeId);
  }, [activeId]);

  const control = desktop?.control === "owner";
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
          <button type="button" className="btn sm accent" onClick={() => giveBack(handback)}>
            Hand back
          </button>
        </div>
      ) : desktop?.request ? (
        <div className="banner attn">
          <Icon name="hand" />
          <div>
            <b>Hatbot needs you:</b> {desktop.request.reason}
          </div>
          <span className="spacer" />
          <button type="button" className="btn sm primary" onClick={() => run(takeover)}>
            Take over
          </button>
        </div>
      ) : null}
      {desktop && !desktop.online ? (
        <div className="screen">
          <div className="screen-note">The desktop isn't answering.</div>
        </div>
      ) : (
        <Screen control={control} />
      )}
      {!control && !desktop?.request && desktop?.online && (
        <div className="live-controls">
          <button type="button" className="btn tint-attn" onClick={() => run(takeover)}>
            <Icon name="hand" />
            Take over
          </button>
          {!task && (
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
          <Link className="live-task" to={`/tasks/${task.id}`}>
            <b>{task.title}</b>
            <Icon name="chevron" />
          </Link>
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
