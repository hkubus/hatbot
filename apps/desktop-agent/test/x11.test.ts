import { expect, test } from "bun:test";
import { pacing, spawn } from "../src/x11";

test("pacing counts sleeps, repeated delays and typing delays", () => {
  expect(pacing(["mousemove", "1", "2", "sleep", "0.5", "mousemove", "3", "4"])).toBe(500);
  expect(pacing(["click", "--repeat", "3", "--delay", "80", "1"])).toBe(240);
  expect(pacing(["type", "--delay", "50", "--", "hello"])).toBe(250);
  expect(pacing(["key", "Return"])).toBe(0);
});

test("a process that runs past its deadline is killed", async () => {
  const started = Date.now();
  await expect(spawn(["sleep", "30"], 0, 200)).rejects.toThrow("didn't finish");
  expect(Date.now() - started).toBeLessThan(3000);
});
