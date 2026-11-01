// Loads a running brain (see benchmarks/serve.ts) from V concurrent keep-alive connections.
//   bun benchmarks/load.ts <path> [connections] [seconds]
const port = process.env.HB_PORT ?? 8099;
const { readFileSync } = await import("node:fs");
const cookie = readFileSync(new URL("./.data/cookie", import.meta.url), "utf8").trim();
const [path = "/api/v1/conversations", conns = "10", seconds = "5"] = process.argv.slice(2);
const url = `http://127.0.0.1:${port}${path}`;
const headers = { cookie, "accept-encoding": "br" };
const first = await fetch(url, { headers });
if (!first.ok) console.log("status", first.status);
await first.arrayBuffer();
const deadline = performance.now() + Number(seconds) * 1000;
let n = 0;
let errors = 0;
let bytes = 0;
const latencies: number[] = [];
const worker = async () => {
  while (performance.now() < deadline) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, { headers });
      bytes += (await r.arrayBuffer()).byteLength;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
    n++;
  }
};
await Promise.all(Array.from({ length: Number(conns) }, worker));
latencies.sort((a, b) => a - b);
const p = (q: number) => latencies[Math.floor(q * (latencies.length - 1))]?.toFixed(2);
console.log(
  `${path.padEnd(40)} ${(n / Number(seconds)).toFixed(0).padStart(6)} req/s  p50 ${p(0.5)} ms  p99 ${p(0.99)} ms  ` +
    `${(bytes / n / 1024).toFixed(1)} KB  errors ${errors}`,
);
