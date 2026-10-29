// Screens desktop tasks drive: the desktop's, and each of your computers'. Each has its own lane, so
// tasks on different screens run at once.
import type {
  AgentAction,
  AgentActionResult,
  AgentElement,
  LiveInput,
} from "@hatbot/shared/desktop";

/** What a desktop task does on a screen, in the screenshot's pixels. */
export interface ScreenAgent {
  screenshot(): Promise<Uint8Array>;
  zoom(region: number[]): Promise<Uint8Array>;
  action(a: AgentAction): Promise<AgentActionResult>;
  /** The element under a point, or the focused one; null where nothing can say. */
  inspect(x?: number, y?: number): Promise<AgentElement | null>;
}

// One task on a screen at a time; Take over, Teach and a rollback hold it too.
export class ScreenLane {
  private holder: number | null = null;
  private queue: { taskId: number; grant: () => void }[] = [];
  /** The holder's way to give the screen up early, for a task waiting ahead of the line. */
  private yielder: (() => void) | null = null;

  get holderId() {
    return this.holder;
  }

  get waiting() {
    return this.queue.length > 0;
  }

  /**
   * `first`: ahead of the line, and the holder is asked to let go as soon as it can (a task you took
   * over for).
   */
  acquire(taskId: number, signal: AbortSignal, first = false): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.holder === null) {
      this.holder = taskId;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        taskId,
        grant: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        this.queue = this.queue.filter((e) => e !== entry);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (first) {
        this.queue.unshift(entry);
        this.yielder?.();
      } else this.queue.push(entry);
    });
  }

  onYield(taskId: number, fn: () => void) {
    if (this.holder === taskId) this.yielder = fn;
  }

  release(taskId: number) {
    if (this.holder !== taskId) return;
    this.yielder = null;
    const next = this.queue.shift();
    this.holder = next?.taskId ?? null;
    next?.grant();
  }
}

/** Take over couldn't give the task that asked the screen: another task is mid-step, or it ended. */
export class ScreenBusy extends Error {}

/**
 * Gives a waiting task the screen for Take over, rejecting with ScreenBusy when it can't; what it returns
 * gives the screen back if Take over fails.
 */
export type Readying = () => Promise<(() => void) | undefined>;

export type ScreenState = {
  online: boolean;
  /** "hatbot": Hatbot may act; "owner": you have control (takeover). */
  control: "hatbot" | "owner";
  request: { taskId: number; reason: string } | null;
  activeTaskId: number | null;
  botId: string | null;
};

/** Who controls a screen: Hatbot, or you after Take over. */
export class ScreenControl {
  protected state: ScreenState = {
    online: false,
    control: "hatbot",
    request: null,
    activeTaskId: null,
    botId: null,
  };
  protected paused = false;
  private waiters = new Set<() => void>();
  private requests: { taskId: number; reason: string }[] = [];
  private served: number | null = null;
  private readying = new Map<number, Readying>();
  private taking: Promise<void> | null = null;

  constructor(
    /** Stops and lets through Hatbot's input on the screen itself. */
    private input: { lock(): Promise<void>; unlock(): Promise<void> },
    private changed: (s: ScreenState) => void,
    /** Where your control is kept, so a brain restart doesn't hand the screen back. */
    private store?: { get(key: string): string | null; set(key: string, value: string): void },
  ) {
    // A request isn't kept: a restart ends the task that asked.
    if (store?.get("control") === "owner") this.state.control = "owner";
  }

  get(): ScreenState {
    return { ...this.state };
  }

  protected set(patch: Partial<ScreenState>) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    if (next.control !== this.state.control) this.store?.set("control", next.control);
    this.state = next;
    this.changed(this.get());
  }

  setActiveTask(taskId: number | null, botId: string | null = null) {
    this.set({ activeTaskId: taskId, botId: taskId === null ? null : botId });
  }

  /**
   * `forRequest`: the first task that asked for you gets the screen first, so you work where it needs
   * you. A second Take over while one is under way is the same one.
   */
  takeover(forRequest = false): Promise<void> {
    this.taking ??= this.take(forRequest).finally(() => {
      this.taking = null;
    });
    return this.taking;
  }

  private async take(forRequest: boolean) {
    const asked = forRequest && this.state.control !== "owner" ? this.state.request : null;
    const ready = asked ? this.readying.get(asked.taskId) : undefined;
    const undo = ready ? await ready() : undefined;
    try {
      await this.input.lock();
    } catch (err) {
      // The task would hold the screen waiting for a hand-back that can't come.
      undo?.();
      throw err;
    }
    this.served = asked?.taskId ?? null;
    this.set({ control: "owner" });
  }

  async handback() {
    // Hand back even if the screen is down; it's locked or unlocked again when it's back.
    if (!this.paused)
      await this.input.unlock().catch((err) => console.error("screen unlock failed", err));
    // The request you took over for is done; another task's waits on.
    this.requests = this.requests.filter((r) => r.taskId !== this.served);
    this.served = null;
    this.set({ control: "hatbot", request: this.requests[0] ?? null });
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** Requests wait in turn; the first is the one shown. */
  requestTakeover(taskId: number, reason: string) {
    this.requests = [...this.requests.filter((r) => r.taskId !== taskId), { taskId, reason }];
    this.set({ request: this.requests[0] ?? null });
  }

  clearRequest(taskId: number) {
    this.requests = this.requests.filter((r) => r.taskId !== taskId);
    this.set({ request: this.requests[0] ?? null });
  }

  onTakeover(taskId: number, ready: Readying): () => void {
    this.readying.set(taskId, ready);
    return () => {
      if (this.readying.get(taskId) === ready) this.readying.delete(taskId);
    };
  }

  waitForHandback(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(done);
        reject(signal.reason);
      };
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.add(done);
    });
  }
}

const LIVE_BUFFER_BYTES = 512 * 1024;

/**
 * One viewer's frames. On a slow connection, skip frames rather than fall behind the screen: the
 * newest goes out once the viewer catches up, since a screen that has gone still sends nothing more.
 * `later` runs a look again after a while.
 */
export function frameRelay(
  send: (frame: ArrayBuffer) => void,
  buffered: () => number,
  later = (fn: () => void) => void setTimeout(fn, 100),
) {
  let behind: ArrayBuffer | null = null;
  let waiting = false;
  const flush = () => {
    waiting = false;
    if (!behind) return;
    if (buffered() < LIVE_BUFFER_BYTES) {
      send(behind);
      behind = null;
    } else {
      waiting = true;
      later(flush);
    }
  };
  return {
    push(frame: ArrayBuffer) {
      behind = frame;
      if (!waiting) flush();
    },
    stop() {
      behind = null;
    },
  };
}

const LIVE_INPUT = new Set(["move", "button", "wheel", "key"]);

/** What a live view may send while you have control. */
export function validLiveInput(m: unknown): m is LiveInput {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  if (!LIVE_INPUT.has(o.t as string)) return false;
  if (o.t === "key")
    return typeof o.key === "string" && o.key.length <= 32 && typeof o.down === "boolean";
  return typeof o.x === "number" && typeof o.y === "number";
}
