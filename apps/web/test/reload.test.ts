import { expect, test } from "bun:test";
import { reloadOnce } from "../src/reload";

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
  };
};

test("a missing chunk reloads the page once, not again within 30 s", () => {
  const storage = memory();
  let reloads = 0;
  const reload = () => {
    reloads++;
  };
  const t = Date.parse("2026-10-17T12:00:00Z");
  expect(reloadOnce(storage, t, reload)).toBe(true);
  // The new build is missing it too: the error reaches the error screen instead.
  expect(reloadOnce(storage, t + 5_000, reload)).toBe(false);
  expect(reloads).toBe(1);
  // A later Update reloads again.
  expect(reloadOnce(storage, t + 60_000, reload)).toBe(true);
  expect(reloads).toBe(2);
});

test("without storage it doesn't reload, so it can't loop", () => {
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {},
  };
  let reloads = 0;
  expect(reloadOnce(blocked, Date.now(), () => reloads++)).toBe(false);
  expect(reloads).toBe(0);
});
