import { expect, test } from "bun:test";
import { readChartData } from "../src/chart-data";

test("a chart file's names are cut between characters, not through one", () => {
  // Half of an emoji is invalid UTF-8: the app's decoder refused the whole chart.
  const long = `${"a".repeat(59)}😀`;
  const read = readChartData(`x,${long}\n1,2\n`, "line", false);
  expect(read).toEqual({ data: { x: [1], series: [{ name: "a".repeat(59), data: [2] }] } });
  const scatter = readChartData(`x,y,label\n1,2,${long}\n`, "scatter", false);
  expect(scatter).toEqual({
    data: { series: [{ points: [{ x: 1, y: 2, label: "a".repeat(59) }] }] },
  });
});

test("a scatter series with no points isn't drawn, and a file with none at all doesn't draw", () => {
  const json = (series: unknown[]) => JSON.stringify({ series });
  expect(
    readChartData(
      json([
        { name: "A", points: [{ x: 1, y: 2 }] },
        { name: "B", points: [] },
      ]),
      "scatter",
      true,
    ),
  ).toEqual({ data: { series: [{ name: "A", points: [{ x: 1, y: 2 }] }] } });
  expect(readChartData(json([{ name: "B", points: [] }]), "scatter", true)).toEqual({
    problem: "it has no points",
  });
});
