import { expect, test } from "bun:test";
import {
  chartValue,
  isStacked,
  niceTicks,
  parseChart,
  seriesNames,
  stackSpans,
  stackTotals,
} from "../src/chart";

test("a chart block parses, and anything else is null", () => {
  const spec = parseChart(
    '{"type":"line","unit":"GiB","x":["12:00","12:05"],"series":[{"data":[1.1,null]}]}',
  );
  expect(spec?.series[0]?.data).toEqual([1.1, null]);
  expect(spec && seriesNames(spec)).toEqual(["Series 1"]);
  // Still streaming.
  expect(parseChart('{"type":"line","x":["a"')).toBeNull();
  // A series that doesn't line up with x.
  expect(parseChart('{"type":"bar","x":["a","b"],"series":[{"data":[1]}]}')).toBeNull();
  // Too many series.
  const four = Array.from({ length: 4 }, () => ({ data: [1] }));
  expect(parseChart(JSON.stringify({ type: "bar", x: ["a"], series: four }))).toBeNull();
  // Nothing to draw.
  expect(parseChart('{"type":"bar","x":["a"],"series":[{"data":[null]}]}')).toBeNull();
});

test("values read the way the owner writes them", () => {
  expect(chartValue(1284)).toBe("1,284");
  expect(chartValue(12900, undefined, true)).toBe("12.9K");
  expect(chartValue(0.4213)).toBe("0.42");
  expect(chartValue(42.25, "%")).toBe("42.3%");
  expect(chartValue(3.1, "GiB")).toBe("3.1 GiB");
  expect(chartValue(4_200_000, "$", true)).toBe("$4.2M");
  expect(chartValue(-12, "€")).toBe("-€12");
  expect(chartValue(0.8, "$")).toBe("$0.80");
  expect(chartValue(12.5, "$")).toBe("$12.50");
  expect(chartValue(1, "$", true)).toBe("$1");
});

test("ticks are round and cover the data", () => {
  expect(niceTicks(0, 87)).toEqual([0, 25, 50, 75, 100]);
  expect(niceTicks(0.1, 0.7)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  expect(niceTicks(-3, 9)).toEqual([-5, 0, 5, 10]);
  expect(niceTicks(5, 5)).toEqual([4.5, 4.75, 5, 5.25, 5.5]);
});

test("stacked bars pile positives up and negatives down, and sum each x", () => {
  const spec = parseChart(
    '{"type":"bar","stacked":true,"x":["a","b"],"series":[{"data":[2,-1]},{"data":[3,null]},{"data":[-4,5]}]}',
  );
  if (!spec) throw new Error("no spec");
  expect(isStacked(spec)).toBe(true);
  expect(stackSpans(spec)).toEqual([
    [
      [0, 2],
      [2, 5],
      [0, -4],
    ],
    [[0, -1], null, [0, 5]],
  ]);
  expect(stackTotals(spec)).toEqual([1, 4]);
  // One series has nothing to stack on.
  const one = parseChart('{"type":"bar","stacked":true,"x":["a"],"series":[{"data":[1]}]}');
  expect(one && isStacked(one)).toBe(false);
});

test("horizontal bars cap their rows", () => {
  const rows = (n: number) =>
    JSON.stringify({
      type: "bar",
      horizontal: true,
      x: Array.from({ length: n }, (_, i) => `host ${i}`),
      series: [{ data: Array.from({ length: n }, () => 1) }],
    });
  expect(parseChart(rows(40))).not.toBeNull();
  expect(parseChart(rows(41))).toBeNull();
});
