// The lanes (PLAN.md §5.6). The screen lane: one task on the desktop at a time, first come first served.

export class ScreenLane {
  private holder: number | null = null;
  private queue: { taskId: number; grant: () => void }[] = [];
  /** The holder's way to give the screen up early, for a task waiting ahead of the line. */
  private yielder: (() => void) | null = null;

  get holderId() {
    return this.holder;
  }

  /** Someone is waiting for the screen. */
  get waiting() {
    return this.queue.length > 0;
  }

  /**
   * Waits for the screen. Rejects if `signal` aborts first. `first`: ahead of the line, and the holder is
   * asked to let go as soon as it can (a task you took over for).
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

  /** The holder says how it lets go early when a task waits ahead of the line. */
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

/** The background lane: up to `size` tasks at once, the rest in order (PLAN.md §5.6). */
export class Pool {
  private active = 0;
  private queue: { grant: () => void }[] = [];

  constructor(readonly size: number) {}

  /** Waits for a slot. Rejects if `signal` aborts first. */
  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.size) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
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
      this.queue.push(entry);
    });
  }

  /** Hands the slot to the next in line. */
  release() {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.active--;
  }
}
