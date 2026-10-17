import { expect, test } from "bun:test";
import { atIso, cronOk, localInput } from "../src/schedule-form";

test("a once-off time is sent as the moment you see, not as the brain's local time", () => {
  // "2026-10-20T09:30" in this browser's time zone, whatever that is.
  const local = "2026-10-20T09:30";
  const iso = atIso(local);
  expect(iso).toMatch(/Z$/);
  expect(new Date(iso).getTime()).toBe(new Date(2026, 9, 20, 9, 30).getTime());
  // And it shows as the same time when it comes back.
  expect(localInput(iso)).toBe(local);
  expect(atIso("")).toBe("");
  expect(atIso("not a time")).toBe("");
});

test("cronOk reads what the brain's croner reads", () => {
  // Checked against croner 10 in the brain.
  const cases: [string, boolean][] = [
    ["0 8 * * *", true],
    ["*/15 * * * *", true],
    ["0 8 * * 1-5", true],
    ["0 8 1 * *", true],
    ["0 8 L * *", true],
    ["0 8 * * 1#2", true],
    ["0 8 * * MON", true],
    ["0 8 * JAN *", true],
    ["0 8 15W * *", true],
    ["0 8 * * 5L", true],
    ["0 8 * * 7", true],
    ["0 8-18/2 * * *", true],
    ["0 8 * * sun-sat", true],
    ["0 8 ? * *", true],
    ["@daily", true],
    ["@hourly", true],
    ["60 8 * * *", false],
    ["0 24 * * *", false],
    ["0 8 0 * *", false],
    ["0 8 * 13 *", false],
    ["0 8 * * 8", false],
    ["*/0 * * * *", false],
    ["0 8 * *", false],
    ["every day", false],
    ["5-1 * * * *", false],
  ];
  for (const [expr, ok] of cases) expect([expr, cronOk(expr)]).toEqual([expr, ok]);
});
