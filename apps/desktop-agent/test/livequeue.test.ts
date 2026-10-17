import { expect, test } from "bun:test";
import type { LiveInput } from "@hatbot/shared/desktop";
import { LiveQueue } from "../src/livequeue";

function recorder() {
  const done: LiveInput[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const run = async (m: LiveInput) => {
    done.push(m);
    // The first input hangs until released, so the rest pile up behind it.
    if (first) {
      first = false;
      await gate;
    }
  };
  return { done, run, release: () => release() };
}

test("pointer moves that pile up are cut to the newest", async () => {
  const r = recorder();
  const q = new LiveQueue(r.run);
  q.push({ t: "button", button: 1, down: true, x: 0, y: 0 });
  for (let i = 1; i <= 5; i++) q.push({ t: "move", x: i, y: i });
  q.push({ t: "button", button: 1, down: false, x: 5, y: 5 });
  q.push({ t: "move", x: 9, y: 9 });
  r.release();
  await Bun.sleep(10);
  expect(r.done).toEqual([
    { t: "button", button: 1, down: true, x: 0, y: 0 },
    { t: "move", x: 5, y: 5 },
    { t: "button", button: 1, down: false, x: 5, y: 5 },
    { t: "move", x: 9, y: 9 },
  ]);
});

test("wheel turns are added up, and come before what follows them", async () => {
  const done: LiveInput[] = [];
  const q = new LiveQueue(async (m) => {
    done.push(m);
  }, 30);
  q.push({ t: "wheel", dx: 0, dy: 50, x: 1, y: 1 });
  q.push({ t: "wheel", dx: 0, dy: 70, x: 2, y: 2 });
  await Bun.sleep(60);
  q.push({ t: "wheel", dx: 0, dy: -40, x: 3, y: 3 });
  q.push({ t: "key", key: "a", down: true });
  await Bun.sleep(10);
  expect(done).toEqual([
    { t: "wheel", dx: 0, dy: 120, x: 2, y: 2 },
    { t: "wheel", dx: 0, dy: -40, x: 3, y: 3 },
    { t: "key", key: "a", down: true },
  ]);
});

test("what's still held down is let go, after what's waiting", async () => {
  const r = recorder();
  const q = new LiveQueue(r.run);
  q.push({ t: "key", key: "Control", down: true });
  q.push({ t: "key", key: "AltGraph", down: true });
  q.push({ t: "key", key: "a", down: true });
  q.push({ t: "key", key: "Shift", down: true });
  q.push({ t: "key", key: "Shift", down: false });
  q.push({ t: "button", button: 1, down: true, x: 10, y: 10 });
  q.push({ t: "move", x: 40, y: 50 });
  q.release();
  r.release();
  await Bun.sleep(10);
  expect(r.done.slice(-3)).toEqual([
    { t: "button", button: 1, down: false, x: 40, y: 50 },
    { t: "key", key: "AltGraph", down: false },
    { t: "key", key: "Control", down: false },
  ]);
  // Nothing is held now, so a second release sends nothing.
  const sent = r.done.length;
  q.release();
  await Bun.sleep(10);
  expect(r.done.length).toBe(sent);
});
