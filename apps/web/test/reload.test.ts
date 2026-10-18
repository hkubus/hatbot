import { expect, test } from "bun:test";
import { reloadOnce } from "../src/reload";
import { MemoryStorage } from "./dom";

test("a missing chunk reloads the page once, never in a loop", () => {
  const storage = new MemoryStorage();
  let reloads = 0;
  const reload = () => {
    reloads++;
  };
  const t = Date.parse("2026-10-17T12:00:00Z");
  expect(reloadOnce(storage, t, reload)).toBe(true);
  // The new build is missing it too: the error reaches the error screen instead.
  expect(reloadOnce(storage, t + 5_000, reload)).toBe(false);
  // A later Update reloads again.
  expect(reloadOnce(storage, t + 60_000, reload)).toBe(true);
  expect(reloads).toBe(2);
  // Without storage it can't tell, so it doesn't reload.
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {},
  };
  expect(reloadOnce(blocked, t, reload)).toBe(false);
  expect(reloads).toBe(2);
});
