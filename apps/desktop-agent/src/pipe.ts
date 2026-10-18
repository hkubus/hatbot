// DevTools over the pipe a Chromium opens with --remote-debugging-pipe (its fds 3 and 4): JSON messages,
// each ending in a NUL. No port, so nothing else on the desktop can reach it. For hatbot-render's boxes.
import { closeSync } from "node:fs";

type Waiting = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class DevToolsPipe {
  private next = 1;
  private waiting = new Map<number, Waiting>();
  private handlers = new Map<string, ((params: unknown) => void)[]>();
  private sink: Bun.FileSink;
  private gone: Error | null = null;

  /** `to` and `from`: this side's ends of Chromium's fds 3 and 4, which close() closes. */
  constructor(
    private to: number,
    private from: number,
  ) {
    // Bun reads and writes copies of the two, and closes those itself.
    this.sink = Bun.file(to).writer();
    void this.read(Bun.file(from).stream());
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.gone) return Promise.reject(this.gone);
    const id = this.next++;
    const p = new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.sink.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    void this.sink.flush();
    return p;
  }

  on(method: string, fn: (params: unknown) => void) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]);
  }

  close() {
    this.gone ??= new Error("Chromium closed DevTools.");
    void Promise.resolve(this.sink.end()).catch(() => {});
    closeSync(this.to);
    closeSync(this.from);
  }

  private async read(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    // A message's pieces until its NUL comes: a screenshot is megabytes.
    let pieces: string[] = [];
    try {
      for await (const chunk of stream) {
        const parts = decoder.decode(chunk, { stream: true }).split("\0");
        for (const part of parts.slice(0, -1)) {
          this.dispatch(pieces.join("") + part);
          pieces = [];
        }
        pieces.push(parts.at(-1) ?? "");
      }
    } catch {
      // Chromium closed its end.
    }
    this.gone = new Error("Chromium closed DevTools.");
    for (const w of this.waiting.values()) w.reject(this.gone);
    this.waiting.clear();
  }

  private dispatch(text: string) {
    const m = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (m.id === undefined) {
      for (const fn of this.handlers.get(m.method ?? "") ?? []) fn(m.params);
      return;
    }
    const w = this.waiting.get(m.id);
    this.waiting.delete(m.id);
    if (m.error) w?.reject(new Error(m.error.message));
    else w?.resolve(m.result);
  }
}
