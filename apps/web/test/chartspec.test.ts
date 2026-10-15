import { describe, expect, test } from "bun:test";
import { parseChart as zodParseChart } from "@hatbot/shared";
import { parseChart } from "../src/chartspec";

const base = { type: "line", x: ["a", "b"], series: [{ data: [1, 2] }] };
const cases: [string, unknown][] = [
  ["the smallest line", base],
  ["every field", { ...base, title: "T", unit: "%", stacked: true, horizontal: false }],
  ["named series", { ...base, series: [{ name: "One", data: [1, null] }] }],
  ["numbers on x", { ...base, x: [1, 2] }],
  ["extra fields are dropped", { ...base, colour: "red", series: [{ data: [1, 2], z: 1 }] }],
  ["an unknown type", { ...base, type: "pie" }],
  ["no x", { ...base, x: [] }],
  ["too many points", { ...base, x: Array(501).fill(1), series: [{ data: Array(501).fill(1) }] }],
  ["a long label", { ...base, x: ["a".repeat(61), "b"] }],
  ["a long title", { ...base, title: "t".repeat(121) }],
  ["a long unit", { ...base, unit: "u".repeat(13) }],
  ["a string value", { ...base, series: [{ data: ["1", 2] }] }],
  ["too few values", { ...base, series: [{ data: [1] }] }],
  ["only gaps", { ...base, series: [{ data: [null, null] }] }],
  ["four series", { ...base, series: Array(4).fill({ data: [1, 2] }) }],
  ["no series", { ...base, series: [] }],
  ["stacked not a boolean", { ...base, stacked: "yes" }],
  ["a long series name", { ...base, series: [{ name: "n".repeat(61), data: [1, 2] }] }],
  [
    "41 horizontal bars",
    {
      type: "bar",
      horizontal: true,
      x: Array(41).fill("a"),
      series: [{ data: Array(41).fill(1) }],
    },
  ],
  [
    "41 upright bars",
    { type: "bar", x: Array(41).fill("a"), series: [{ data: Array(41).fill(1) }] },
  ],
  ["an array", [base]],
  ["null", null],
];

describe("the web's chart check", () => {
  for (const [name, spec] of cases)
    test(`agrees with ChartSpec: ${name}`, () => {
      const source = JSON.stringify(spec);
      expect(parseChart(source)).toEqual(zodParseChart(source));
    });
  test("unfinished JSON isn't a chart", () => {
    expect(parseChart('{"type": "line", "x": [1')).toBeNull();
  });
});
