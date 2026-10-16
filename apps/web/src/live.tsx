// The desktop's live view (PLAN.md §10.5): JPEG frames over a WebSocket, drawn to a canvas.
// While you have control, your pointer and keys go to the desktop.
import { API_PREFIX, latestNoteOnly, type TaskStep } from "@hatbot/shared";
import type { LiveInput } from "@hatbot/shared/desktop";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { Icon } from "./icons";
import { navigate } from "./router";
import {
  discardTeach,
  ensureSteps,
  handback,
  recording,
  startTeach,
  stopTeach,
  takeover,
  useStore,
} from "./store";
import { taskLine } from "./tasks";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

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
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}/desktop/live`;
    const ws = new WebSocket(url);
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
  const close = () => {
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
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
    },
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
  // A background task's tool calls.
  if (kind === "action" && name?.startsWith("memory_")) return <Icon name="book" />;
  if (kind === "action" && name === "search_history") return <Icon name="chat" />;
  return <Icon name={STEP_ICON[kind]} />;
}

/** The live screen with takeover controls, and what the task on it is doing. */
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
    fn().catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't reach Hatbot."));
  };

  const stop = () =>
    run(async () => {
      const s = await stopTeach();
      navigate(`/memory/teach/${s.id}`);
    });
  const discard = (id: number) => {
    if (confirm("Throw this recording away?")) run(() => discardTeach(id));
  };

  return (
    <div className="live">
      {teach ? (
        <div className="control-banner attn">
          <Icon name="teach" />
          Recording. Show Hatbot how.
          <div className="actions">
            <button type="button" className="btn sm" onClick={() => discard(teach.id)}>
              Discard
            </button>
            <button type="button" className="btn sm primary" onClick={stop}>
              Stop & create skill
            </button>
          </div>
        </div>
      ) : control ? (
        <div className="control-banner attn">
          <Icon name="hand" />
          You're in control. Hatbot is paused.
          <span className="spacer" />
          <button type="button" className="btn sm primary" onClick={() => run(handback)}>
            Hand back
          </button>
        </div>
      ) : desktop?.request ? (
        <div className="control-banner ask">
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
          <button type="button" className="live-task" onClick={() => navigate(`/tasks/${task.id}`)}>
            <b>{task.title}</b>
            <Icon name="chevron" />
          </button>
          <div className="label">{taskLine(task, progress)}</div>
          {steps && steps.length > 0 && (
            <ul className="log">
              {latestNoteOnly(steps)
                .slice(-6)
                .reverse()
                .map((s) => (
                  <li
                    key={s.id}
                    className={s.kind === "approval" || s.kind === "takeover" ? "attn" : ""}
                  >
                    <span className="t">{time(s.createdAt)}</span>
                    <StepIcon kind={s.kind} />
                    <span>{s.detail || s.name}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
