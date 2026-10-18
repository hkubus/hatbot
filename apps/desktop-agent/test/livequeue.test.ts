import { expect, test } from "bun:test";
import type { LiveInput } from "@hatbot/shared/desktop";
import { LiveQueue } from "../src/livequeue";

test("what's still held down is let go, after what's waiting", async () => {
  const done: LiveInput[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // The first input hangs until released, so the rest pile up behind it.
  const q = new LiveQueue(async (m) => {
    done.push(m);
    if (done.length === 1) await gate;
  });
  q.push({ t: "key", key: "Control", down: true });
  q.push({ t: "key", key: "AltGraph", down: true });
  q.push({ t: "key", key: "a", down: true });
  q.push({ t: "key", key: "Shift", down: true });
  q.push({ t: "key", key: "Shift", down: false });
  q.push({ t: "button", button: 1, down: true, x: 10, y: 10 });
  q.push({ t: "move", x: 40, y: 50 });
  q.release();
  release();
  await Bun.sleep(10);
  expect(done.slice(-3)).toEqual([
    { t: "button", button: 1, down: false, x: 40, y: 50 },
    { t: "key", key: "AltGraph", down: false },
    { t: "key", key: "Control", down: false },
  ]);
  // Nothing is held now, so a second release sends nothing.
  const sent = done.length;
  q.release();
  await Bun.sleep(10);
  expect(done.length).toBe(sent);
});
