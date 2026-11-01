// An answer the size of a screenshot's, as the DevTools client reads it: the frame parsed whole (what
// every answer used to cost) against reading the id and the result out of it.
//   bun apps/desktop-agent/bench/dispatch.ts
// Run it with --smol, as apps/linux's desktop is small: without, Bun's heap grows for ten seconds
// before it collects, and most of the parse's cost shows up as growth instead of time.
import { report, time } from "./common";

const bytes = Number(process.env.BENCH_SCREEN ?? 1280 * 800 * 2);
const data = Buffer.alloc(bytes, 0x9a).toString("base64");
const frame = `{"id":7,"result":{"data":${JSON.stringify(data)}}}`;
console.log(`${frame.length} bytes an answer, ${bytes} of them the screenshot`);

const { shotData } = await import("../src/browser");
if (shotData(frame)?.length !== data.length) throw new Error("the picture wasn't read");

console.log(report("JSON.parse whole frame (before)", await time(() => JSON.parse(frame), 200)));
console.log(
  report(
    "reading the id and the picture",
    await time(() => {
      /^\{"id":(\d+),/.exec(frame);
      shotData(frame);
    }, 200),
  ),
);
