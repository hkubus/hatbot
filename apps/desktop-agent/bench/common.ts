// What the benchmarks share: a loop that drives one code path N times and reports time a call and heap.
export type Timing = { n: number; ms: number; perMs: number; heapMb: number; peakMb: number };

/**
 * Runs `fn` n times, timed; `heapMb` is the growth in Bun's heap, and `peakMb` the most above it that
 * one call added, worked out before a collection (one also drops what a call frees).
 */
export async function time(fn: () => unknown | Promise<unknown>, n: number): Promise<Timing> {
  for (let i = 0; i < Math.min(n, 3); i++) await fn();
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  let peak = 0;
  const started = performance.now();
  for (let i = 0; i < n; i++) {
    await fn();
    if (i % 10 === 9) peak = Math.max(peak, process.memoryUsage().heapUsed - before);
  }
  const ms = performance.now() - started;
  return {
    n,
    ms,
    perMs: ms / n,
    heapMb: (process.memoryUsage().heapUsed - before) / 1024 / 1024,
    peakMb: peak / 1024 / 1024,
  };
}

export const report = (label: string, t: Timing) =>
  `${label.padEnd(38)} ${t.n.toString().padStart(5)} ×  ${t.ms.toFixed(0).padStart(7)} ms  ${t.perMs.toFixed(3).padStart(9)} ms/call  heap ${t.heapMb.toFixed(1).padStart(6)} MB  peak ${t.peakMb.toFixed(1).padStart(6)} MB`;
