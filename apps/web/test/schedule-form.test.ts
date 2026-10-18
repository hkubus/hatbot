import { expect, test } from "bun:test";
import { Cron } from "croner";
import { atIso, cronOk, localInput } from "../src/schedule-form";

/** What the brain takes: five fields or a nickname like @daily, that croner can read. */
function brainTakes(expr: string) {
  if (expr.trim().split(/\s+/).length !== 5 && !expr.trim().startsWith("@")) return false;
  try {
    new Cron(expr, { paused: true });
    return true;
  } catch {
    return false;
  }
}

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
  const cases = [
    "0 8 * * *",
    "*/15 * * * *",
    "0 8 * * 1-5",
    "0 8 1 * *",
    "0 8 L * *",
    "0 8 * * 1#2",
    "0 8 * * MON",
    "0 8 * JAN *",
    "0 8 15W * *",
    "0 8 * * 5L",
    "0 8 * * 7",
    "0 8-18/2 * * *",
    "0 8 * * sun-sat",
    "0 8 ? * *",
    "@daily",
    "@hourly",
    "60 8 * * *",
    "0 24 * * *",
    "0 8 0 * *",
    "0 8 * 13 *",
    "0 8 * * 8",
    "*/0 * * * *",
    "0 8 * *",
    "every day",
    "5-1 * * * *",
  ];
  for (const expr of cases) expect([expr, cronOk(expr)]).toEqual([expr, brainTakes(expr)]);
});
