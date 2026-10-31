// What reading a large answer whole cost, against what it costs to read only its answer: a page's
// script answer of about half a megabyte, the size find's answer about a long page comes back as.
//   bun --smol apps/desktop-agent/bench/receive.ts
import { payload, report, time } from "./common";

const COUNT = Number(process.env.BENCH_LINES ?? 5000);
const value = payload(COUNT);
// An evaluate's answer is `{result: {value}}`: what the client reads is the `{value:"…"}` inside it.
const frame = `{"id":7,"result":${JSON.stringify({ value })}}`;
const inner = frame.indexOf('{"value":');
console.log(`${frame.length} bytes a page's answer, ${COUNT} lines`);

const { spare } = await import("../src/browser");
// What it was: the frame whole, and every part of it an object of its own.
console.log(report("JSON.parse whole frame (before)", await time(() => JSON.parse(frame), 500)));
let read = 0;
console.log(
  report(
    "the answer alone",
    await time(() => {
      read += (spare(frame, inner) as string).length;
    }, 500),
  ),
);
if (!read) throw new Error("nothing read");
