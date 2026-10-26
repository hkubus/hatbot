// Charts in replies: a ```chart fenced block holding this JSON. The clients draw it in Hatbot's own
// style; anywhere else (Copy, search, an older client) it stays a readable code block. Line, bar and
// scatter can name a file with their values instead (ChartFile), for more than are worth typing out.
import { z } from "zod";

/** Past three series the colours stop telling apart for colour-blind readers. */
export const CHART_MAX_SERIES = 3;
/** Values typed into a block, or drawn from a file once the brain has thinned it. */
export const CHART_MAX_POINTS = 500;
export const CHART_FILE_MAX_ROWS = 100_000;
/** Horizontal bars take a row each, so fewer of them. */
export const CHART_MAX_ROWS = 40;
/** A matrix's columns share the width of a phone. */
export const CHART_MAX_COLUMNS = 8;
export const CHART_MAX_EVENTS = 60;
/** Timeline lanes are told apart by row, not colour, but each needs its own row. */
export const CHART_MAX_LANES = 8;
export const CHART_MAX_LISTINGS = 30;

/** Where listing photos may come from: the marketplaces' image servers, as Scout keeps them. */
const PHOTO_HOSTS = ["olxcdn.com", "allegroimg.com", "vinted.net"];

/** An http or https address written out in full; with `https`, only https. */
export function webAddress(s: string, https = false): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return !!u.hostname && (u.protocol === "https:" || (!https && u.protocol === "http:"));
  } catch {
    return false;
  }
}

/**
 * Whether the brain fetches this photo for a listings block. Anything else would let a reply make it
 * ask any server for an address of its choosing, with whatever the reply put in it.
 */
export function listingPhoto(s: string): boolean {
  if (!webAddress(s, true)) return false;
  const u = new URL(s);
  if (u.port || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PHOTO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const title = z.string().max(120).optional();
/** "%", "GiB", "ms", or a currency symbol ("$", "€"), which goes in front. */
const unit = z.string().max(12).optional();
const label = z.string().min(1).max(60);
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const date = z.string().regex(DATE, "a date is YYYY, YYYY-MM or YYYY-MM-DD");
/** Values and a file together: which would it draw? */
const notWithData = z.never({ error: "give the values or data, not both" }).optional();
const noData = z.never({ error: "only line, bar and scatter can draw from a file" }).optional();

/** Line and bar: one value per x for each series. */
const SeriesChart = z
  .object({
    type: z.enum(["line", "bar"]),
    title,
    unit,
    /** Bars: the series stack into one bar per x, as parts of its total. */
    stacked: z.boolean().optional(),
    /** Bars: one row per x, for rankings and long names. */
    horizontal: z.boolean().optional(),
    data: notWithData,
    x: z
      .array(z.union([z.string().max(60), z.number()]))
      .min(1)
      .max(CHART_MAX_POINTS),
    series: z
      .array(
        z.object({
          name: z.string().max(60).optional(),
          /** One value per x; null is a gap. */
          data: z.array(z.number().nullable()),
        }),
      )
      .min(1)
      .max(CHART_MAX_SERIES),
  })
  .refine((s) => s.series.every((se) => se.data.length === s.x.length), {
    message: "each series needs one value per x",
  })
  .refine((s) => s.series.some((se) => se.data.some((v) => v !== null)), {
    message: "no values",
  })
  .refine((s) => !(s.type === "bar" && s.horizontal) || s.x.length <= CHART_MAX_ROWS, {
    message: `at most ${CHART_MAX_ROWS} horizontal bars`,
  });
export type SeriesChart = z.infer<typeof SeriesChart>;

/** Points on two measured axes, for trade-offs (price against noise). */
const ScatterChart = z
  .object({
    type: z.literal("scatter"),
    title,
    xName: z.string().max(60).optional(),
    xUnit: unit,
    yName: z.string().max(60).optional(),
    yUnit: unit,
    data: notWithData,
    series: z
      .array(
        z.object({
          name: z.string().max(60).optional(),
          points: z
            .array(z.object({ x: z.number(), y: z.number(), label: label.optional() }))
            .min(1),
        }),
      )
      .min(1)
      .max(CHART_MAX_SERIES),
  })
  .refine((s) => s.series.reduce((n, se) => n + se.points.length, 0) <= CHART_MAX_POINTS, {
    message: `at most ${CHART_MAX_POINTS} points in all`,
  });
export type ScatterChart = z.infer<typeof ScatterChart>;

/** A span from low to high for each row (prices across shops), with an optional mark inside it. */
const RangeChart = z.object({
  type: z.literal("range"),
  title,
  unit,
  /** What the mark is: "median", "cheapest new". */
  markName: z.string().max(60).optional(),
  data: noData,
  rows: z
    .array(
      z
        .object({ label, low: z.number(), high: z.number(), mark: z.number().optional() })
        .refine((r) => r.low <= r.high, { message: "low is above high" })
        .refine((r) => r.mark === undefined || (r.mark >= r.low && r.mark <= r.high), {
          message: "mark is outside low to high",
        }),
    )
    .min(1)
    .max(CHART_MAX_ROWS),
});
export type RangeChart = z.infer<typeof RangeChart>;

/** Options against criteria, a value in each cell; each column is shaded from its worst to its best. */
const MatrixChart = z
  .object({
    type: z.literal("matrix"),
    title,
    data: noData,
    rows: z.array(label).min(1).max(CHART_MAX_ROWS),
    columns: z
      .array(
        z.object({
          name: label,
          unit,
          /** Which end is better: "low" for prices and noise. Higher is better by default. */
          better: z.enum(["high", "low"]).optional(),
        }),
      )
      .min(1)
      .max(CHART_MAX_COLUMNS),
    /** One list per row, a value per column; null where it isn't known. */
    values: z.array(z.array(z.number().nullable())),
  })
  .refine((s) => s.values.length === s.rows.length, { message: "values needs one list per row" })
  .refine((s) => s.values.every((r) => r.length === s.columns.length), {
    message: "each row of values needs one value per column",
  });
export type MatrixChart = z.infer<typeof MatrixChart>;

/** Dated events, or spans with an end, in order along one axis; lanes split them into rows. */
const TimelineChart = z
  .object({
    type: z.literal("timeline"),
    title,
    data: noData,
    events: z
      .array(
        z
          .object({ date, end: date.optional(), label, lane: z.string().max(40).optional() })
          .refine((e) => e.end === undefined || dateRange(e.date)[0] <= dateRange(e.end)[1], {
            message: "end is before date",
          }),
      )
      .min(1)
      .max(CHART_MAX_EVENTS),
  })
  .refine((s) => new Set(s.events.map((e) => e.lane ?? "")).size <= CHART_MAX_LANES, {
    message: `at most ${CHART_MAX_LANES} lanes`,
  });
export type TimelineChart = z.infer<typeof TimelineChart>;

/** Things for sale, as a row of cards to scroll: a photo, the title, the price and where it is. */
const ListingsChart = z.object({
  type: z.literal("listings"),
  title,
  /** The prices' currency: "zł", "€". */
  unit,
  data: noData,
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        url: z
          .string()
          .max(2000)
          .refine((s) => webAddress(s), "url must be an http or https address"),
        price: z.number().optional(),
        /** The listing's photo; only listingPhoto's are shown. */
        photo: z
          .string()
          .max(2000)
          .refine((s) => webAddress(s, true), "photo must be an https address")
          .optional(),
        /** "OLX", "Vinted". */
        site: z.string().max(40).optional(),
        /** A few words the title doesn't say: "Like new, Kraków". */
        note: z.string().max(80).optional(),
      }),
    )
    .min(1)
    .max(CHART_MAX_LISTINGS),
});
export type ListingsChart = z.infer<typeof ListingsChart>;

/** An attachment's id: a CSV, TSV or JSON file holding the values (apps/brain/src/chart-data.ts). */
const data = z.number().int().positive();
const SeriesFile = z.object({
  type: z.enum(["line", "bar"]),
  title,
  unit,
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  data,
  x: notWithData,
  series: notWithData,
});
const ScatterFile = z.object({
  type: z.literal("scatter"),
  title,
  xName: z.string().max(60).optional(),
  xUnit: unit,
  yName: z.string().max(60).optional(),
  yUnit: unit,
  data,
  series: notWithData,
});
const FILE_KINDS = { line: SeriesFile, bar: SeriesFile, scatter: ScatterFile };

/**
 * A chart that draws from a file. The clients get its values, thinned to CHART_MAX_POINTS, from
 * GET /api/attachments/:data/chart?type= (ChartData), and draw them as the ChartSpec they make.
 */
export const ChartFile = z.union([SeriesFile, ScatterFile]);
export type ChartFile = z.infer<typeof ChartFile>;

/** What GET /api/attachments/:id/chart gives: the values a ChartFile leaves out. */
export type ChartData = Pick<SeriesChart, "x" | "series"> | Pick<ScatterChart, "series">;

const KINDS = {
  line: SeriesChart,
  bar: SeriesChart,
  scatter: ScatterChart,
  range: RangeChart,
  matrix: MatrixChart,
  timeline: TimelineChart,
  listings: ListingsChart,
};
type Kind = keyof typeof KINDS;

export const ChartSpec = z.union([
  SeriesChart,
  ScatterChart,
  RangeChart,
  MatrixChart,
  TimelineChart,
  ListingsChart,
]);
export type ChartSpec = z.infer<typeof ChartSpec>;

/** The first and last day a timeline date covers, as UTC milliseconds: 2024-03 is all of March. */
export function dateRange(d: string): [number, number] {
  const [y, m, day] = d.split("-").map(Number) as [number, number?, number?];
  if (day !== undefined) {
    const t = Date.UTC(y, (m ?? 1) - 1, day);
    return [t, t];
  }
  if (m !== undefined) return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 0)];
  return [Date.UTC(y, 0, 1), Date.UTC(y, 11, 31)];
}

/** The spec in a chart block, or null if it isn't one (still streaming, or malformed). */
export function parseChart(source: string): ChartSpec | null {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return null;
  }
  const p = ChartSpec.safeParse(json);
  return p.success ? p.data : null;
}

export function parseChartFile(source: string): ChartFile | null {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return null;
  }
  const p = ChartFile.safeParse(json);
  return p.success ? p.data : null;
}

/**
 * Why a chart block's source doesn't draw, in words the model can fix it from; null if it does. For a
 * file chart, only the block: whether the file draws is the brain's to check.
 */
export function chartProblem(source: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (err) {
    return `it isn't valid JSON (${(err as Error).message})`;
  }
  // Checked against its own kind, so the problem names that kind's fields, not every kind's.
  const type = (json as { type?: unknown } | null)?.type;
  const kind = typeof type === "string" && Object.hasOwn(KINDS, type) ? KINDS[type as Kind] : null;
  if (!kind) return `type must be one of ${Object.keys(KINDS).join(", ")}`;
  if (
    (json as { data?: unknown }).data !== undefined &&
    Object.hasOwn(FILE_KINDS, type as string)
  ) {
    const p = FILE_KINDS[type as keyof typeof FILE_KINDS].safeParse(json);
    return p.success ? null : z.prettifyError(p.error).replace(/\s*\n\s*/g, "; ");
  }
  const p = kind.safeParse(json);
  if (p.success) return null;
  // The usual slip: a long series typed out by hand with a value too many or too few.
  const o = json as { x?: unknown; series?: unknown };
  const values = (n: number) => `${n} value${n === 1 ? "" : "s"}`;
  if (Array.isArray(o?.x) && Array.isArray(o.series)) {
    const xs = o.x.length;
    const off = o.series.flatMap((se: { name?: unknown; data?: unknown }, i) =>
      Array.isArray(se?.data) && se.data.length !== xs
        ? [
            `series ${typeof se.name === "string" ? `"${se.name}"` : i + 1} has ${values(se.data.length)}`,
          ]
        : [],
    );
    if (off.length) return `x has ${values(xs)} but ${off.join(" and ")}`;
  }
  return z.prettifyError(p.error).replace(/\s*\n\s*/g, "; ");
}

/** Each ```chart block in a reply, closed or not: where its source sits in the text. */
export function chartBlocks(markdown: string): { start: number; end: number; source: string }[] {
  const blocks: { start: number; end: number; source: string }[] = [];
  const fence = /^[ \t]*(`{3,}|~{3,})[ \t]*chart[ \t]*\n/gm;
  for (let m = fence.exec(markdown); m; m = fence.exec(markdown)) {
    const start = m.index + m[0].length;
    const close = new RegExp(`^[ \\t]*${m[1]}[ \\t]*$`, "m");
    const at = close.exec(markdown.slice(start));
    const end = at ? start + at.index : markdown.length;
    blocks.push({ start, end, source: markdown.slice(start, end).replace(/\n$/, "") });
    fence.lastIndex = at ? end + at[0].length : markdown.length;
  }
  return blocks;
}

/** The chart blocks in a reply that don't draw: each with why, and `n`, which one it is from 1. */
export function brokenCharts(markdown: string) {
  return chartBlocks(markdown).flatMap((b, i) => {
    const problem = chartProblem(b.source);
    return problem ? [{ ...b, problem, n: i + 1 }] : [];
  });
}

/** Series names, with "Series 2" for one Hatbot left unnamed. */
export const seriesNames = (s: { series: { name?: string }[] }) =>
  s.series.map((se, i) => se.name || `Series ${i + 1}`);

export const isStacked = (s: SeriesChart) => s.type === "bar" && !!s.stacked && s.series.length > 1;

/** Each x's stack of bars: [start, end] per series, positives up from 0 and negatives down. */
export function stackSpans(s: SeriesChart): ([number, number] | null)[][] {
  return s.x.map((_, i) => {
    let up = 0;
    let down = 0;
    return s.series.map((se) => {
      const v = se.data[i];
      if (v == null || v === 0) return null;
      const side = v > 0 ? up : down;
      if (v > 0) up += v;
      else down += v;
      return [side, side + v];
    });
  });
}

export const stackTotals = (s: SeriesChart) =>
  s.x.map((_, i) => {
    const vs = s.series.map((se) => se.data[i]).filter((v): v is number => v != null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) : null;
  });

const CURRENCY = /^[$€£¥₽₹]$/;

/** 1,284 · 12.9K · 0.42 · $4.2M · 87% · 3.1 GiB. Compact from 1,000 up when `compact`. */
export function chartValue(v: number, unit?: string, compact = false): string {
  const a = Math.abs(v);
  const short = compact && a >= 1000;
  const money = !!unit && CURRENCY.test(unit);
  const digits = short ? 1 : a >= 100 ? 0 : a >= 10 ? 1 : 2;
  const n = new Intl.NumberFormat("en-US", {
    notation: short ? "compact" : "standard",
    // Money under 100 keeps its cents ($0.80), except on axis ticks ($1).
    minimumFractionDigits: money && !compact && a < 100 && v % 1 !== 0 ? 2 : 0,
    maximumFractionDigits: money && !compact && a < 100 ? 2 : digits,
  }).format(v);
  if (!unit) return n;
  if (money) return v < 0 ? `-${unit}${n.slice(1)}` : `${unit}${n}`;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

/** Round tick values covering [lo, hi], about `count` of them. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (lo === hi) {
    const pad = Math.abs(lo) / 10 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = start; t < hi + step * 0.999; t += step) {
    // Float steps drift (0.30000000000000004); round to the step's precision.
    ticks.push(Number(t.toPrecision(12)));
    if (ticks.length > 20) break;
  }
  return ticks;
}
