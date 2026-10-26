import { expect, test } from "bun:test";
import { calendarWeeks, chartProblem, parseChart, parseChartFile, treemap } from "../src/chart";

test("a chart block parses, or says why not in words the model can fix it from", () => {
  const spec = parseChart(
    '{"type":"line","unit":"GiB","x":["12:00","12:05"],"series":[{"data":[1.1,null]}]}',
  );
  expect(spec?.series[0]?.data).toEqual([1.1, null]);
  // The usual slip: a series a value too long.
  const long =
    '{"type":"line","x":["a","b"],"series":[{"name":"wan","data":[1,2]},{"name":"lan","data":[0,0,0]}]}';
  expect(parseChart(long)).toBeNull();
  expect(chartProblem(long)).toBe('x has 2 values but series "lan" has 3 values');
  // Still streaming.
  expect(parseChart('{"type":"line","x":["a"')).toBeNull();
  expect(chartProblem('{"type":"line","x":["a"')).toStartWith("it isn't valid JSON");
});

test("line, bar and scatter can name a file for their values instead, but not both", () => {
  expect(parseChartFile('{"type":"line","unit":"%","data":12}')).toEqual({
    type: "line",
    unit: "%",
    data: 12,
  });
  expect(chartProblem('{"type":"scatter","data":12}')).toBeNull();
  const both = '{"type":"line","data":12,"x":["a"],"series":[{"data":[1]}]}';
  expect(parseChart(both)).toBeNull();
  expect(parseChartFile(both)).toBeNull();
  expect(chartProblem(both)).toContain("give the values or data, not both");
  expect(
    chartProblem('{"type":"range","data":12,"rows":[{"label":"A","low":1,"high":2}]}'),
  ).toContain("only line, bar and scatter can draw from a file");
});

test("a treemap's boxes fill the space, each sized by its value, as near square as it gets", () => {
  const tiles = treemap([6, 6, 4, 3, 2, 2, 1], 6, 4);
  expect(tiles.map((t) => [t.i, ...[t.x, t.y, t.w, t.h].map((v) => Number(v.toFixed(2)))])).toEqual(
    [
      [0, 0, 0, 3, 2],
      [1, 0, 2, 3, 2],
      [2, 3, 0, 1.71, 2.33],
      [3, 4.71, 0, 1.29, 2.33],
      [4, 3, 2.33, 1.2, 1.67],
      [5, 4.2, 2.33, 1.2, 1.67],
      [6, 5.4, 2.33, 0.6, 1.67],
    ],
  );
});

test("a calendar's weeks start on Monday, from the first day's week to the last's", () => {
  const weeks = calendarWeeks(["2026-10-26", "2026-10-01"]);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  expect(weeks.map((w) => day(w[0] as number))).toEqual([
    "2026-09-28",
    "2026-10-05",
    "2026-10-12",
    "2026-10-19",
    "2026-10-26",
  ]);
  expect(day(weeks.at(-1)?.[6] as number)).toBe("2026-11-01");
});
