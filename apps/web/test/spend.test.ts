import { describe, expect, test } from "bun:test";
import { spendAxis, withToday } from "../src/spend";

describe("spendAxis", () => {
  test("scales to the days, not the limit, and leaves out a limit above them", () => {
    const a = spendAxis([0.2, 0.31, 0.12], 5);
    expect(a.max).toBe(0.4);
    expect(a.ticks.map(a.tick)).toEqual(["$0.00", "$0.10", "$0.20", "$0.30", "$0.40"]);
    expect(a.showLimit).toBe(false);
  });

  test("draws the limit once a day comes near it", () => {
    const a = spendAxis([1, 4.6, 2], 5);
    expect(a.max).toBe(5);
    expect(a.showLimit).toBe(true);
    expect(a.ticks.map(a.tick)).toEqual(["$0", "$1", "$2", "$3", "$4", "$5"]);
  });

  test("nothing spent: whole cents on the axis", () => {
    const a = spendAxis([0, 0, 0]);
    expect(a.max).toBe(0.05);
    expect(a.ticks.map(a.tick)).toEqual(["$0.00", "$0.01", "$0.02", "$0.03", "$0.04", "$0.05"]);
    expect(a.showLimit).toBe(false);
  });

  test("ticks under a dollar keep two decimals", () => {
    const a = spendAxis([0.8]);
    expect(a.ticks.map(a.tick)).toEqual(["$0.00", "$0.20", "$0.40", "$0.60", "$0.80"]);
  });
});

describe("withToday", () => {
  const days = [
    { date: "2026-10-15", usd: 1 },
    { date: "2026-10-16", usd: 2 },
    { date: "2026-10-17", usd: 0.5 },
  ];

  test("today's new total takes the place of the last day", () => {
    expect(withToday(days, [{ date: "2026-10-17", usd: 0.9 }])).toEqual([
      { date: "2026-10-15", usd: 1 },
      { date: "2026-10-16", usd: 2 },
      { date: "2026-10-17", usd: 0.9 },
    ]);
  });

  test("past midnight, the new day is added and the oldest drops off", () => {
    expect(withToday(days, [{ date: "2026-10-18", usd: 0 }])).toEqual([
      { date: "2026-10-16", usd: 2 },
      { date: "2026-10-17", usd: 0.5 },
      { date: "2026-10-18", usd: 0 },
    ]);
  });

  test("before the 30 days are read, or with an older day, nothing changes", () => {
    expect(withToday([], [{ date: "2026-10-17", usd: 1 }])).toEqual([]);
    expect(withToday(days, [{ date: "2026-10-16", usd: 9 }])).toBe(days);
    expect(withToday(days, [])).toBe(days);
  });
});
