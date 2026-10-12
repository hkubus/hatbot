import { expect, test } from "bun:test";
import { keyGap, path } from "../src/human";

/** A repeatable stand-in for Math.random. */
const seeded =
  (seed = 1) =>
  () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

test("the pointer's path ends exactly on the target, bowing off the straight line", () => {
  const steps = path({ x: 100, y: 100 }, { x: 700, y: 400 }, seeded());
  expect(steps.at(-1)).toEqual({ x: 700, y: 400 });
  expect(steps.length).toBeGreaterThanOrEqual(20);
  // Not a straight line: some point is well off it.
  const off = steps.map(
    (p) => Math.abs((p.x - 100) * 300 - (p.y - 100) * 600) / Math.hypot(600, 300),
  );
  expect(Math.max(...off)).toBeGreaterThan(5);
  // Slow at the ends, fast in the middle.
  const gap = (i: number) =>
    Math.hypot(
      (steps[i + 1]?.x ?? 0) - (steps[i]?.x ?? 0),
      (steps[i + 1]?.y ?? 0) - (steps[i]?.y ?? 0),
    );
  const mid = Math.floor(steps.length / 2);
  expect(gap(mid)).toBeGreaterThan(gap(0));
});

test("no path to where the pointer already is; a short hop still takes a few steps", () => {
  expect(path({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([]);
  const hop = path({ x: 0, y: 0 }, { x: 30, y: 0 }, seeded(7));
  expect(hop.at(-1)).toEqual({ x: 30, y: 0 });
  expect(hop.length).toBeGreaterThan(1);
});

test("keys come 35-110 ms apart, with the odd longer pause", () => {
  const rand = seeded(3);
  const gaps = Array.from({ length: 2000 }, () => keyGap(rand));
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(35);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(400);
  expect(gaps.some((g) => g > 180)).toBe(true);
});
