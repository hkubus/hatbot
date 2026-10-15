// The web's own check of a chart block, the same rules as ChartSpec in @hatbot/shared but by hand:
// it's the only zod the web would run, and zod is a seventh of the bundle. test/chartspec.test.ts
// keeps the two in step.
import { CHART_MAX_POINTS, CHART_MAX_ROWS, CHART_MAX_SERIES, type ChartSpec } from "@hatbot/shared";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (v: unknown, max: number) =>
  v === undefined || (typeof v === "string" && v.length <= max);
const optBoolean = (v: unknown) => v === undefined || typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The spec in a chart block, or null if it isn't one (still streaming, or malformed). */
export function parseChart(source: string): ChartSpec | null {
  let o: unknown;
  try {
    o = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObject(o)) return null;
  const { type, title, unit, stacked, horizontal, x, series } = o;
  if (type !== "line" && type !== "bar") return null;
  if (!optString(title, 120) || !optString(unit, 12)) return null;
  if (!optBoolean(stacked) || !optBoolean(horizontal)) return null;
  if (!Array.isArray(x) || x.length < 1 || x.length > CHART_MAX_POINTS) return null;
  if (!x.every((v) => (typeof v === "string" && v.length <= 60) || isNumber(v))) return null;
  if (!Array.isArray(series) || series.length < 1 || series.length > CHART_MAX_SERIES) return null;
  const parsed: ChartSpec["series"] = [];
  for (const se of series) {
    if (!isObject(se) || !optString(se.name, 60) || !Array.isArray(se.data)) return null;
    if (!se.data.every((v) => v === null || isNumber(v))) return null;
    if (se.data.length !== x.length) return null;
    parsed.push({
      ...(se.name === undefined ? {} : { name: se.name as string }),
      data: se.data as (number | null)[],
    });
  }
  if (!parsed.some((se) => se.data.some((v) => v !== null))) return null;
  if (type === "bar" && horizontal && x.length > CHART_MAX_ROWS) return null;
  return {
    type,
    ...(title === undefined ? {} : { title: title as string }),
    ...(unit === undefined ? {} : { unit: unit as string }),
    ...(stacked === undefined ? {} : { stacked: stacked as boolean }),
    ...(horizontal === undefined ? {} : { horizontal: horizontal as boolean }),
    x: x as (string | number)[],
    series: parsed,
  };
}
