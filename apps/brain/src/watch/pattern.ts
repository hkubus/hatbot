// A watcher's pattern runs here, on a thread of its own, so one that backtracks without end can be
// stopped (extract.ts) rather than freezing the brain.
declare const self: Worker;

export type PatternJob = { pattern: string; text: string };

if (typeof self !== "undefined" && !Bun.isMainThread)
  self.onmessage = (e: MessageEvent<PatternJob>) => {
    const m = new RegExp(e.data.pattern, "i").exec(e.data.text);
    self.postMessage(m ? (m[1] ?? m[0]) : null);
  };
