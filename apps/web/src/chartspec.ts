// By hand rather than zod: zod is a seventh of the bundle. test/chartspec.test.ts keeps this in
// step with ChartSpec in @hatbot/shared.
import {
  CHART_MAX_COLUMNS,
  CHART_MAX_EVENTS,
  CHART_MAX_LANES,
  CHART_MAX_LISTINGS,
  CHART_MAX_POINTS,
  CHART_MAX_ROWS,
  CHART_MAX_SERIES,
  type ChartData,
  type ChartFile,
  type ChartSpec,
  dateRange,
  type ListingsChart,
  type MatrixChart,
  type RangeChart,
  type ScatterChart,
  type SeriesChart,
  type TimelineChart,
  webAddress,
} from "@hatbot/shared";

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (v: unknown, max: number) =>
  v === undefined || (typeof v === "string" && v.length <= max);
const optBoolean = (v: unknown) => v === undefined || typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optNumber = (v: unknown) => v === undefined || isNumber(v);
const isLabel = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 60;
const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(v);
const optDate = (v: unknown) => v === undefined || isDate(v);
const list = (v: unknown, min: number, max = Number.POSITIVE_INFINITY): v is unknown[] =>
  Array.isArray(v) && v.length >= min && v.length <= max;

/** Only the keys the spec knows, and only those given, as zod's parse leaves them. */
function pick<T>(o: Obj, keys: string[], rest: Obj): T {
  const out: Obj = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return { ...out, ...rest } as T;
}

export function parseChart(source: string): ChartSpec | null {
  let o: unknown;
  try {
    o = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObject(o)) return null;
  if (!optString(o.title, 120) || o.data !== undefined) return null;
  switch (o.type) {
    case "line":
    case "bar":
      return series(o);
    case "scatter":
      return scatter(o);
    case "range":
      return range(o);
    case "matrix":
      return matrix(o);
    case "timeline":
      return timeline(o);
    case "listings":
      return listings(o);
    default:
      return null;
  }
}

export function parseChartFile(source: string): ChartFile | null {
  let o: unknown;
  try {
    o = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObject(o) || !optString(o.title, 120)) return null;
  const { type, data } = o;
  if (typeof data !== "number" || !Number.isInteger(data) || data < 1) return null;
  if (o.x !== undefined || o.series !== undefined) return null;
  if (type === "line" || type === "bar") {
    if (!optString(o.unit, 12) || !optBoolean(o.stacked) || !optBoolean(o.horizontal)) return null;
    return pick(o, ["type", "title", "unit", "stacked", "horizontal", "data"], {});
  }
  if (type !== "scatter") return null;
  if (!optString(o.xName, 60) || !optString(o.yName, 60)) return null;
  if (!optString(o.xUnit, 12) || !optString(o.yUnit, 12)) return null;
  return pick(o, ["type", "title", "xName", "xUnit", "yName", "yUnit", "data"], {});
}

export function withData(file: ChartFile, values: ChartData): ChartSpec | null {
  const { data: _, ...block } = file;
  const { x } = values as { x?: unknown };
  return parseChart(JSON.stringify({ ...block, x, series: values.series }));
}

function series(o: Obj): SeriesChart | null {
  const { type, unit, stacked, horizontal, x, series } = o;
  if (!optString(unit, 12) || !optBoolean(stacked) || !optBoolean(horizontal)) return null;
  if (!list(x, 1, CHART_MAX_POINTS)) return null;
  if (!x.every((v) => (typeof v === "string" && v.length <= 60) || isNumber(v))) return null;
  if (!list(series, 1, CHART_MAX_SERIES)) return null;
  const parsed: SeriesChart["series"] = [];
  for (const se of series) {
    if (!isObject(se) || !optString(se.name, 60) || !Array.isArray(se.data)) return null;
    if (!se.data.every((v) => v === null || isNumber(v))) return null;
    if (se.data.length !== x.length) return null;
    parsed.push(pick(se, ["name", "data"], {}));
  }
  if (!parsed.some((se) => se.data.some((v) => v !== null))) return null;
  if (type === "bar" && horizontal && x.length > CHART_MAX_ROWS) return null;
  return pick(o, ["type", "title", "unit", "stacked", "horizontal", "x"], { series: parsed });
}

function scatter(o: Obj): ScatterChart | null {
  const { xName, xUnit, yName, yUnit, series } = o;
  if (!optString(xName, 60) || !optString(yName, 60)) return null;
  if (!optString(xUnit, 12) || !optString(yUnit, 12)) return null;
  if (!list(series, 1, CHART_MAX_SERIES)) return null;
  const parsed: ScatterChart["series"] = [];
  for (const se of series) {
    if (!isObject(se) || !optString(se.name, 60) || !list(se.points, 1)) return null;
    const points: ScatterChart["series"][number]["points"] = [];
    for (const p of se.points) {
      if (!isObject(p) || !isNumber(p.x) || !isNumber(p.y)) return null;
      if (p.label !== undefined && !isLabel(p.label)) return null;
      points.push(pick(p, ["x", "y", "label"], {}));
    }
    parsed.push(pick(se, ["name"], { points }));
  }
  if (parsed.reduce((n, se) => n + se.points.length, 0) > CHART_MAX_POINTS) return null;
  return pick(o, ["type", "title", "xName", "xUnit", "yName", "yUnit"], { series: parsed });
}

function range(o: Obj): RangeChart | null {
  const { unit, markName, rows } = o;
  if (!optString(unit, 12) || !optString(markName, 60)) return null;
  if (!list(rows, 1, CHART_MAX_ROWS)) return null;
  const parsed: RangeChart["rows"] = [];
  for (const r of rows) {
    if (!isObject(r) || !isLabel(r.label) || !isNumber(r.low) || !isNumber(r.high)) return null;
    if (!optNumber(r.mark) || r.low > r.high) return null;
    if (isNumber(r.mark) && (r.mark < r.low || r.mark > r.high)) return null;
    parsed.push(pick(r, ["label", "low", "high", "mark"], {}));
  }
  return pick(o, ["type", "title", "unit", "markName"], { rows: parsed });
}

function matrix(o: Obj): MatrixChart | null {
  const { rows, columns, values } = o;
  if (!list(rows, 1, CHART_MAX_ROWS) || !rows.every(isLabel)) return null;
  if (!list(columns, 1, CHART_MAX_COLUMNS)) return null;
  const parsed: MatrixChart["columns"] = [];
  for (const c of columns) {
    if (!isObject(c) || !isLabel(c.name) || !optString(c.unit, 12)) return null;
    if (c.better !== undefined && c.better !== "high" && c.better !== "low") return null;
    parsed.push(pick(c, ["name", "unit", "better"], {}));
  }
  if (!Array.isArray(values) || values.length !== rows.length) return null;
  for (const r of values)
    if (!Array.isArray(r) || r.length !== columns.length) return null;
    else if (!r.every((v) => v === null || isNumber(v))) return null;
  return pick(o, ["type", "title", "rows"], { columns: parsed, values });
}

function timeline(o: Obj): TimelineChart | null {
  const { events } = o;
  if (!list(events, 1, CHART_MAX_EVENTS)) return null;
  const parsed: TimelineChart["events"] = [];
  for (const e of events) {
    if (!isObject(e) || !isDate(e.date) || !optDate(e.end) || !isLabel(e.label)) return null;
    if (!optString(e.lane, 40)) return null;
    if (isDate(e.end) && dateRange(e.date)[0] > dateRange(e.end)[1]) return null;
    parsed.push(pick(e, ["date", "end", "label", "lane"], {}));
  }
  if (new Set(parsed.map((e) => e.lane ?? "")).size > CHART_MAX_LANES) return null;
  return pick(o, ["type", "title"], { events: parsed });
}

function listings(o: Obj): ListingsChart | null {
  const { unit, items } = o;
  if (!optString(unit, 12) || !list(items, 1, CHART_MAX_LISTINGS)) return null;
  const parsed: ListingsChart["items"] = [];
  for (const it of items) {
    if (!isObject(it) || typeof it.title !== "string" || !it.title || it.title.length > 200)
      return null;
    if (typeof it.url !== "string" || it.url.length > 2000 || !webAddress(it.url)) return null;
    if (
      it.photo !== undefined &&
      !(optString(it.photo, 2000) && webAddress(it.photo as string, true))
    )
      return null;
    if (!optNumber(it.price) || !optString(it.site, 40) || !optString(it.note, 80)) return null;
    parsed.push(pick(it, ["title", "url", "price", "photo", "site", "note"], {}));
  }
  return pick(o, ["type", "title", "unit"], { items: parsed });
}
