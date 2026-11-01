// What a screenshot costs: one image in, one WebP out, offscreen on generated screens.
//   bun apps/desktop-agent/bench/screenshot.ts
// A UI screen is mostly flat, a marketplace grid of photos is not, and noise is the worst case.
// Big screens compress to more than LOSSLESS_MAX (150 KB, in x11.ts), and the lossy WebP they then go
// through costs about half again a second's worth of one screen here: it's the x11grab before it that a
// screenshot mostly waits for, and the model's copy of it that the lossy one makes smaller.
import { spawn, webp } from "../src/x11";

// A screen as a PNG on the pipe: what Chromium's screenshot comes as.
const PNG = ["-c:v", "png", "-f", "image2pipe", "-"];
const SHAPES: Record<string, string> = {
  // Bars, a ring and a sine: what a page of text and boxes compresses to.
  ui: "testsrc2=size=1280x800:rate=1",
  // Smooth gradients: a grid of marketplace photos.
  photos: "mandelbrot|scale=1280:800",
  // A screen of random pixels: the worst any compressor gets.
  noise: "nullsrc=size=1280x800,geq=random(1)*255:128:128",
};
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const median = (n: number[]) => [...n].sort((a, b) => a - b)[Math.floor(n.length / 2)] ?? 0;

async function screen(name: string, source: string) {
  const [input, ...filters] = source.split("|");
  const vf = filters.length ? ["-vf", filters.join(",")] : [];
  const { code, out, err } = await spawn(
    ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", input, ...vf, "-frames:v", "1", ...PNG],
    0,
    60_000,
  );
  if (code || !out.length) throw new Error(`${name}: ${err.slice(0, 200)}`);
  const runs = Number(process.env.BENCH_RUNS ?? 5);
  const sizes: number[] = [];
  await webp(out);
  const started = performance.now();
  for (let i = 0; i < runs; i++) sizes.push((await webp(out)).length);
  const ms = (performance.now() - started) / runs;
  console.log(
    `${name.padEnd(10)} in ${kb(out.length).padStart(8)}  out ${kb(median(sizes)).padStart(8)}  ${ms.toFixed(0).padStart(5)} ms`,
  );
}

for (const [name, input] of Object.entries(SHAPES)) await screen(name, input);
