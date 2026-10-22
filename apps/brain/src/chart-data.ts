// A chart block's "data" can name an attachment, so the model doesn't type out thousands of values.
import {
  CHART_FILE_MAX_ROWS,
  CHART_MAX_POINTS,
  CHART_MAX_ROWS,
  CHART_MAX_SERIES,
  type ChartData,
  type ChartFile,
  chartBlocks,
  chartProblem,
  parseChartFile,
  type ScatterChart,
  type SeriesChart,
} from "@hatbot/shared";
import type { Attachments } from "./attachments";

type Kind = ChartFile["type"];
type Series = SeriesChart["series"];
type ScatterSeries = ScatterChart["series"];
type Read = { data: ChartData } | { problem: string };

export function csvRows(text: string): string[][] {
  const first = text.slice(0, text.indexOf("\n") >>> 0);
  const sep = first.includes("\t") ? "\t" : first.includes(";") && !first.includes(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const BLANK = /^(|null|nan|na|n\/a|none|-)$/i;
/** A cell as a value: null for a gap, undefined if it isn't a number. */
function cell(s: string | undefined): number | null | undefined {
  const t = (s ?? "").trim();
  if (BLANK.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
const name = (s: string | undefined) => s?.trim().slice(0, 60) || undefined;
const isValue = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));

function seriesFromCsv(rows: string[][]): Read {
  const [head, ...body] = rows;
  if (!head || head.length < 2)
    return { problem: "it needs a header row and two columns or more: x, then one per series" };
  if (head.length - 1 > CHART_MAX_SERIES)
    return {
      problem: `it has ${head.length - 1} value columns, and a chart draws at most ${CHART_MAX_SERIES} series`,
    };
  const series: Series = head.slice(1).map((h) => ({ name: name(h), data: [] }));
  for (const [i, r] of body.entries()) {
    for (const [j, se] of series.entries()) {
      const v = cell(r[j + 1]);
      if (v === undefined)
        return {
          problem: `row ${i + 2}, column "${head[j + 1]}": "${r[j + 1]?.slice(0, 40)}" isn't a number`,
        };
      se.data.push(v);
    }
  }
  const xs = body.map((r) => (r[0] ?? "").trim());
  const numeric = xs.every((v) => v !== "" && Number.isFinite(Number(v)));
  return { data: { x: numeric ? xs.map(Number) : xs, series } };
}

function seriesFromJson(o: { x?: unknown; series?: unknown }): Read {
  const { x, series } = o;
  if (!Array.isArray(x) || !Array.isArray(series))
    return { problem: 'its JSON needs "x" and "series", as a chart block has them' };
  if (!x.every((v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v))))
    return { problem: "each x must be a string or a number" };
  if (series.length < 1 || series.length > CHART_MAX_SERIES)
    return { problem: `"series" needs 1 to ${CHART_MAX_SERIES} series` };
  const out: Series = [];
  for (const [i, se] of series.entries()) {
    const data = (se as { data?: unknown })?.data;
    if (!Array.isArray(data) || !data.every(isValue))
      return { problem: `series ${i + 1} needs "data", a number or null per x` };
    if (data.length !== x.length)
      return { problem: `x has ${x.length} values but series ${i + 1} has ${data.length}` };
    const n = (se as { name?: unknown }).name;
    out.push({ name: typeof n === "string" ? name(n) : undefined, data });
  }
  return { data: { x: x as (string | number)[], series: out } };
}

function scatterFromCsv(rows: string[][]): Read {
  const [head, ...body] = rows;
  const col = (n: string) => head?.findIndex((h) => h.trim().toLowerCase() === n) ?? -1;
  const [xi, yi] = col("x") >= 0 && col("y") >= 0 ? [col("x"), col("y")] : [0, 1];
  const [si, li] = [col("series"), col("label")];
  if (!head || head.length < 2) return { problem: "it needs a header row and columns x and y" };
  const groups = new Map<string, ScatterSeries[number]>();
  for (const [i, r] of body.entries()) {
    const x = cell(r[xi]);
    const y = cell(r[yi]);
    // A point without both isn't one; a word where a number goes is a mistake worth naming.
    if (x === undefined || y === undefined)
      return { problem: `row ${i + 2}: x and y must be numbers` };
    if (x === null || y === null) continue;
    const key = si >= 0 ? (r[si] ?? "").trim() : "";
    let group = groups.get(key);
    if (!group) {
      if (groups.size === CHART_MAX_SERIES)
        return {
          problem: `its series column has more than ${CHART_MAX_SERIES} series, the most a chart draws`,
        };
      group = { name: name(key), points: [] };
      groups.set(key, group);
    }
    const label = li >= 0 ? name(r[li]) : undefined;
    group.points.push(label ? { x, y, label } : { x, y });
  }
  return { data: { series: [...groups.values()] } };
}

function scatterFromJson(o: { series?: unknown }): Read {
  const { series } = o;
  if (!Array.isArray(series) || series.length < 1 || series.length > CHART_MAX_SERIES)
    return {
      problem: `its JSON needs "series", 1 to ${CHART_MAX_SERIES} of them, as a chart block has`,
    };
  const out: ScatterSeries = [];
  for (const [i, se] of series.entries()) {
    const points = (se as { points?: unknown })?.points;
    if (!Array.isArray(points)) return { problem: `series ${i + 1} needs "points"` };
    const kept: ScatterSeries[number]["points"] = [];
    for (const p of points as { x?: unknown; y?: unknown; label?: unknown }[]) {
      if (typeof p?.x !== "number" || typeof p.y !== "number" || !isValue(p.x) || !isValue(p.y))
        return { problem: `series ${i + 1}: each point needs numbers x and y` };
      const label = typeof p.label === "string" ? name(p.label) : undefined;
      kept.push(label ? { x: p.x, y: p.y, label } : { x: p.x, y: p.y });
    }
    const n = (se as { name?: unknown }).name;
    out.push({ name: typeof n === "string" ? name(n) : undefined, points: kept });
  }
  return { data: { series: out } };
}

/**
 * Each series' highest and lowest value in each of as many stretches of x as fit in `max` points, so
 * a spike in 50,000 values still shows. A stretch with no values keeps one x, a gap.
 */
export function thinSeries(d: { x: (string | number)[]; series: Series }, max = CHART_MAX_POINTS) {
  const n = d.x.length;
  if (n <= max) return d;
  const stretches = Math.floor(max / (2 * d.series.length));
  const keep = new Set<number>();
  for (let b = 0; b < stretches; b++) {
    const from = Math.floor((b * n) / stretches);
    const to = Math.floor(((b + 1) * n) / stretches);
    let any = false;
    for (const { data } of d.series) {
      let lo = -1;
      let hi = -1;
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v == null) continue;
        if (lo < 0 || v < (data[lo] as number)) lo = i;
        if (hi < 0 || v > (data[hi] as number)) hi = i;
      }
      if (lo >= 0) keep.add(lo).add(hi);
      any ||= lo >= 0;
    }
    if (!any) keep.add(from);
  }
  const at = [...keep].sort((a, b) => a - b);
  return {
    x: at.map((i) => d.x[i] as string | number),
    series: d.series.map((se) => ({ ...se, data: at.map((i) => se.data[i] ?? null) })),
  };
}

/**
 * At most `max` points, spread like the whole: every cell of a grid over the chart that has points
 * keeps one, so outliers stay, and the rest are shared among the cells by how many each has.
 */
export function thinScatter(series: ScatterSeries, max = CHART_MAX_POINTS): ScatterSeries {
  const all = series.flatMap((se, s) => se.points.map((p) => ({ p, s })));
  if (all.length <= max) return series;
  const span = (vs: number[]) => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of vs) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi - lo || 1] as const;
  };
  const [x0, w] = span(all.map(({ p }) => p.x));
  const [y0, h] = span(all.map(({ p }) => p.y));
  let cells: Map<string, number[]>;
  for (let n = 64; ; n = Math.floor(n * 0.8)) {
    const at = (v: number, lo: number, size: number) =>
      Math.min(n - 1, Math.floor(((v - lo) / size) * n));
    cells = new Map();
    for (const [i, { p, s }] of all.entries()) {
      const key = `${s}:${at(p.x, x0, w)}:${at(p.y, y0, h)}`;
      const cell = cells.get(key);
      if (cell) cell.push(i);
      else cells.set(key, [i]);
    }
    if (cells.size <= max / 2 || n <= 1) break;
  }
  const spare = max - cells.size;
  const rest = all.length - cells.size;
  const keep = new Set<number>();
  for (const cell of cells.values()) {
    const quota = Math.min(cell.length, 1 + Math.floor((spare * (cell.length - 1)) / rest));
    for (let k = 0; k < quota; k++) keep.add(cell[Math.floor((k * cell.length) / quota)] as number);
  }
  return series.map((se, s) => ({
    ...se,
    points: all.flatMap((a, i) => (a.s === s && keep.has(i) ? [a.p] : [])),
  }));
}

export function readChartData(text: string, kind: Kind, json: boolean, horizontal = false): Read {
  let read: Read;
  if (json) {
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      return { problem: "it isn't valid JSON" };
    }
    if (typeof o !== "object" || o === null || Array.isArray(o))
      return { problem: "its JSON must be an object, with the fields a chart block would have" };
    read = kind === "scatter" ? scatterFromJson(o) : seriesFromJson(o);
  } else {
    const rows = csvRows(text);
    if (rows.length - 1 > CHART_FILE_MAX_ROWS)
      return {
        problem: `it has ${rows.length - 1} rows, and a chart draws from at most ${CHART_FILE_MAX_ROWS}`,
      };
    read = kind === "scatter" ? scatterFromCsv(rows) : seriesFromCsv(rows);
  }
  if ("problem" in read) return read;
  if ("x" in read.data) {
    const { x, series } = read.data;
    if (x.length > CHART_FILE_MAX_ROWS)
      return {
        problem: `it has ${x.length} rows, and a chart draws from at most ${CHART_FILE_MAX_ROWS}`,
      };
    if (!x.length || !series.some((se) => se.data.some((v) => v !== null)))
      return { problem: "it has no values" };
    if (x.some((v) => typeof v === "string" && v.length > 60))
      return { problem: "an x is longer than 60 characters" };
    if (kind === "bar" && horizontal && x.length > CHART_MAX_ROWS)
      return {
        problem: `it has ${x.length} rows, and horizontal bars are at most ${CHART_MAX_ROWS}`,
      };
    // Bars past a few hundred are slivers, and only the model knows whether to add or average them.
    if (kind === "bar" && x.length > CHART_MAX_POINTS)
      return {
        problem: `it has ${x.length} rows, and a bar chart draws at most ${CHART_MAX_POINTS} bars: draw a line, or group the rows first`,
      };
    return { data: thinSeries({ x, series }) };
  }
  const total = read.data.series.reduce((n, se) => n + se.points.length, 0);
  if (!total) return { problem: "it has no points" };
  if (total > CHART_FILE_MAX_ROWS)
    return {
      problem: `it has ${total} points, and a chart draws from at most ${CHART_FILE_MAX_ROWS}`,
    };
  return { data: { series: thinScatter(read.data.series) } };
}

const TEXT = ["application/json", "text/csv", "text/tab-separated-values", "text/plain"];
/** Safe to cache: a file never changes once saved. */
const cache = new WeakMap<Attachments, Map<string, Read>>();

export async function chartData(
  attachments: Attachments,
  id: number,
  kind: Kind,
  horizontal = false,
): Promise<Read & { gone?: true }> {
  const key = `${id}:${kind}:${horizontal}`;
  const mine = cache.get(attachments) ?? new Map<string, Read>();
  cache.set(attachments, mine);
  const hit = mine.get(key);
  if (hit) return hit;
  const a = attachments.get(id);
  const bytes = a && (await attachments.bytes(id));
  if (!a || !bytes) return { problem: "it's gone", gone: true };
  if (!TEXT.includes(a.mediaType)) return { problem: `it's ${a.mediaType}, not CSV, TSV or JSON` };
  const json = a.mediaType === "application/json" || /\.json$/i.test(a.name);
  const read = readChartData(new TextDecoder().decode(bytes), kind, json, horizontal);
  mine.set(key, read);
  if (mine.size > 20) mine.delete(mine.keys().next().value as string);
  return read;
}

export async function chartProblemOf(source: string, attachments?: Attachments) {
  const problem = chartProblem(source);
  if (problem) return problem;
  const file = parseChartFile(source);
  if (!file) return null;
  if (!attachments) return "charts can't draw from a file here";
  const horizontal = file.type === "bar" && !!file.horizontal;
  const read = await chartData(attachments, file.data, file.type, horizontal);
  return "problem" in read ? `its file, attachment #${file.data}: ${read.problem}` : null;
}

export async function brokenChartsOf(markdown: string, attachments?: Attachments) {
  const broken: { start: number; end: number; source: string; problem: string; n: number }[] = [];
  for (const [i, b] of chartBlocks(markdown).entries()) {
    const problem = await chartProblemOf(b.source, attachments);
    if (problem) broken.push({ ...b, problem, n: i + 1 });
  }
  return broken;
}
