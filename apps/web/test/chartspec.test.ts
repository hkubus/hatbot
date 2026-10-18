import { expect, test } from "bun:test";
import { parseChart as zodParseChart, parseChartFile as zodParseChartFile } from "@hatbot/shared";
import { parseChart, parseChartFile } from "../src/chartspec";

const base = { type: "line", x: ["a", "b"], series: [{ data: [1, 2] }] };
const bars = (n: number, horizontal?: boolean) => ({
  type: "bar",
  horizontal,
  x: Array(n).fill("a"),
  series: [{ data: Array(n).fill(1) }],
});
const scatter = { type: "scatter", series: [{ points: [{ x: 1, y: 2 }] }] };
const range = { type: "range", rows: [{ label: "A", low: 1, high: 3 }] };
const matrix = { type: "matrix", rows: ["A"], columns: [{ name: "Price" }], values: [[1]] };
const timeline = { type: "timeline", events: [{ date: "2024", label: "A" }] };
const sources = [
  ...[
    base,
    { ...base, title: "T", unit: "%", stacked: true, horizontal: false },
    { ...base, colour: "red", series: [{ name: "One", data: [1, null], z: 1 }] },
    { ...base, type: "pie" },
    { ...base, x: Array(501).fill(1), series: [{ data: Array(501).fill(1) }] },
    { ...base, x: ["a".repeat(61), "b"] },
    { ...base, series: [{ data: ["1", 2] }] },
    { ...base, series: [{ data: [1] }] },
    { ...base, series: [{ data: [null, null] }] },
    { ...base, series: Array(4).fill({ data: [1, 2] }) },
    bars(41, true),
    bars(41),
    [base],
    {
      ...scatter,
      title: "T",
      xName: "Price",
      xUnit: "$",
      yName: "Noise",
      yUnit: "dB",
      series: [{ name: "One", points: [{ x: 1, y: 2, label: "A", z: 1 }], z: 1 }],
      z: 1,
    },
    { ...scatter, series: [{ points: [] }] },
    { ...scatter, series: [{ points: [{ x: 1, y: "2" }] }] },
    { ...scatter, series: [{ points: [{ x: 1, y: 2, label: "" }] }] },
    { ...scatter, series: Array(4).fill(scatter.series[0]) },
    { ...scatter, series: Array(2).fill({ points: Array(251).fill({ x: 1, y: 1 }) }) },
    {
      ...range,
      unit: "$",
      markName: "median",
      rows: [{ label: "A", low: 1, high: 3, mark: 2, z: 1 }],
    },
    { ...range, rows: [{ label: "A", low: 3, high: 1 }] },
    { ...range, rows: [{ label: "A", low: 1, high: 3, mark: 4 }] },
    { ...range, rows: [] },
    { ...range, rows: Array(41).fill(range.rows[0]) },
    {
      ...matrix,
      columns: [{ name: "Price", unit: "$", better: "low", z: 1 }, { name: "Noise" }],
      values: [[1, null]],
    },
    { ...matrix, columns: [{ name: "Price", better: "middle" }] },
    { ...matrix, values: [[1, 2]] },
    { ...matrix, values: [] },
    { ...matrix, rows: [""] },
    { ...matrix, columns: Array(9).fill({ name: "C" }), values: [Array(9).fill(1)] },
    {
      ...timeline,
      events: [
        { date: "2024-03", end: "2024-03-15", label: "A", lane: "Work", z: 1 },
        { date: "2024-03-31", end: "2024-03", label: "B" },
      ],
    },
    { ...timeline, events: [{ date: "2024-03-02", end: "2024-03-01", label: "A" }] },
    { ...timeline, events: [{ date: "2024-13", label: "A" }] },
    { ...timeline, events: [{ date: "24", label: "A" }] },
    {
      ...timeline,
      events: Array.from({ length: 9 }, (_, i) => ({ date: "2024", label: "A", lane: `${i}` })),
    },
    { ...timeline, events: Array(61).fill(timeline.events[0]) },
    { type: "line", title: "T", unit: "%", stacked: false, horizontal: true, data: 3, z: 1 },
    { type: "scatter", xName: "Price", yUnit: "dB", data: 3 },
    { ...base, data: 3 },
    { ...range, data: 3 },
    { type: "bar", data: 0 },
    { type: "line", data: "3" },
    { type: "line", unit: "x".repeat(13), data: 3 },
  ].map((spec) => JSON.stringify(spec)),
  // Still streaming.
  '{"type": "line", "x": [1',
];

test("the web's hand-written chart check agrees with ChartSpec", () => {
  for (const source of sources)
    expect([source, parseChart(source), parseChartFile(source)]).toEqual([
      source,
      zodParseChart(source),
      zodParseChartFile(source),
    ]);
});
