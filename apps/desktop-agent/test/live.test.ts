import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in for ffmpeg: it prints parts of an MJPEG stream, from the file FFMPEG_SCRIPT names, a
// frame's own header before each one, and two the same in a row (an idle screen's).
const dir = mkdtempSync(join(tmpdir(), "hatbot-live-"));
const frames = join(dir, "frames");
// Its own folder: x11.ts runs ffmpeg with the display's DISPLAY, which is a name here, not a program.
const bin = join(dir, "bin");
mkdirSync(bin);
const fake = join(bin, "ffmpeg");
writeFileSync(
  fake,
  `#!${process.execPath}
const frames = ${JSON.stringify(frames)};
const read = await Bun.file(frames).arrayBuffer();
await Bun.write(Bun.stdout, new Uint8Array(read));
Bun.sleep(50).then(() => process.exit(0));
`,
);
chmodSync(fake, 0o755);
const part = (bytes: Uint8Array) =>
  Buffer.concat([
    Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${bytes.length}\r\n\r\n`),
    bytes,
    Buffer.from("\r\n"),
  ]);
const one = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const two = new Uint8Array([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
writeFileSync(frames, Buffer.concat([part(one), part(two), part(two), part(one)]));

const realPath = process.env.PATH;
process.env.PATH = `${bin}:${realPath ?? ""}`;
// The display as the program that runs on it, which is this file's stand-in.
process.env.DISPLAY = fake;
const { LiveCapture, spawn, takeFrame } = await import("../src/x11");
afterAll(() => {
  process.env.PATH = realPath;
});

test("frames go out where they lie, and one the same as the last doesn't", async () => {
  // Started the way x11.ts starts it, which is what finds the stand-in by name.
  await spawn(["ffmpeg"]);
  const live = new LiveCapture({ width: 10, height: 10 }, 5);
  const seen: Uint8Array[] = [];
  const off = live.subscribe((frame) => seen.push(frame));
  while (seen.length < 3) await Bun.sleep(5);
  await Bun.sleep(50);
  off();
  expect(seen.map((f) => [...f])).toEqual([[...one], [...two], [...one]]);
});

test("a part's headers are found from where the last part ended", () => {
  const buf = Buffer.concat([part(one), part(two)]);
  const first = takeFrame(buf);
  expect(first).toEqual({ start: buf.indexOf(one), end: buf.indexOf(one) + one.length });
  const second = takeFrame(buf, first?.end);
  expect(second).toEqual({ start: buf.indexOf(two), end: buf.indexOf(two) + two.length });
  expect(takeFrame(buf, second?.end)).toBeNull();
});
