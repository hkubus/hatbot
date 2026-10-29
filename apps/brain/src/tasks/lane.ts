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
