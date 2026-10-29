// One computer's socket: requests out with ids, answers and status in, and its live frames.
import { PluginError } from "@hatbot/plugin-sdk";
import type {
  ComputerErrorCode,
  ComputerHello,
  ComputerMessage,
  ComputerRequest,
  ComputerResult,
  ComputerStatus,
} from "@hatbot/shared/computer";

/** Why a request failed; "offline" when the computer went away before it answered. */
export class ComputerError extends PluginError {
  constructor(
    message: string,
    readonly code: ComputerErrorCode | "offline",
  ) {
    super(message);
  }
}

type Op = ComputerRequest["op"];
export type ResultOf<O extends Op> = Extract<ComputerResult, { op: O }>;

export class Link {
  status: ComputerStatus;
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (r: ComputerResult) => void; reject: (e: Error) => void }
  >();
  private closed = false;

  constructor(
    readonly hello: ComputerHello,
    private send: (text: string) => void,
    readonly close: (code: number, reason: string) => void,
  ) {
    this.status = {
      enabled: hello.enabled,
      locked: false,
      ownerActive: false,
      paused: false,
      screen: null,
    };
  }

  get open() {
    return !this.closed;
  }

  request<O extends Op>(
    req: Extract<ComputerRequest, { op: O }>,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<ResultOf<O>> {
    if (this.closed) return Promise.reject(new ComputerError("It isn't connected.", "offline"));
    signal?.throwIfAborted();
    const id = this.next++;
    return new Promise<ResultOf<O>>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        done();
        reject(new ComputerError("It didn't answer in time.", "failed"));
      }, timeoutMs);
      const abort = () => {
        done();
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (r) => {
          done();
          resolve(r as ResultOf<O>);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      this.send(JSON.stringify({ t: "req", id, req } satisfies ComputerMessage));
    });
  }

  /** True when the status changed. */
  receive(m: ComputerMessage): boolean {
    if (m.t === "status") {
      this.status = m.status;
      return true;
    }
    if (m.t !== "res") return false;
    const p = this.pending.get(m.id);
    if (!p) return false;
    if (m.ok) p.resolve(m.res);
    else p.reject(new ComputerError(m.error || "It couldn't do that.", m.code));
    return false;
  }

  gone() {
    this.closed = true;
    for (const p of this.pending.values())
      p.reject(new ComputerError("It went offline.", "offline"));
    this.pending.clear();
  }
}
