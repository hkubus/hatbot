import { expect, test } from "bun:test";
import { parseChart as zodParseChart } from "@hatbot/shared";
import { parseChart } from "../src/chartspec";

const base = { type: "line", x: ["a", "b"], series: [{ data: [1, 2] }] };
const bars = (n: number, horizontal?: boolean) => ({
  type: "bar",
  horizontal,
  x: Array(n).fill("a"),
  series: [{ data: Array(n).fill(1) }],
});
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
  ].map((spec) => JSON.stringify(spec)),
  // Still streaming.
  '{"type": "line", "x": [1',
];

test("the web's hand-written chart check agrees with ChartSpec", () => {
  for (const source of sources)
    expect([source, parseChart(source)]).toEqual([source, zodParseChart(source)]);
});
