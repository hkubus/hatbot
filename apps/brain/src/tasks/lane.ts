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

/** The background lane: up to `size` tasks at once, the rest in order. */
export class Pool {
  private active = 0;
  private queue: { grant: () => void }[] = [];

  constructor(readonly size: number) {}

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

  release() {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.active--;
  }
}
