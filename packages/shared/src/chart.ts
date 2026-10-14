// Charts in replies: a ```chart fenced block holding this JSON. The clients draw it in Hatbot's own
// style; anywhere else (Copy, search, an older client) it stays a readable code block.
import { z } from "zod";

/** Past three series the colours stop telling apart for colour-blind readers. */
export const CHART_MAX_SERIES = 3;
export const CHART_MAX_POINTS = 500;
/** Horizontal bars take a row each, so fewer of them. */
export const CHART_MAX_ROWS = 40;

export const ChartSpec = z
  .object({
    type: z.enum(["line", "bar"]),
    title: z.string().max(120).optional(),
    /** "%", "GiB", "ms", or a currency symbol ("$", "€"), which goes in front. */
    unit: z.string().max(12).optional(),
    /** Bars: the series stack into one bar per x, as parts of its total. */
    stacked: z.boolean().optional(),
    /** Bars: one row per x, for rankings and long names. */
    horizontal: z.boolean().optional(),
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
export type ChartSpec = z.infer<typeof ChartSpec>;

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

/** Why a chart block's source doesn't draw, in words the model can fix it from; null if it does. */
export function chartProblem(source: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (err) {
    return `it isn't valid JSON (${(err as Error).message})`;
  }
  const p = ChartSpec.safeParse(json);
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

/** Series names, with "Series 2" for one Hatbot left unnamed. */
export const seriesNames = (s: ChartSpec) => s.series.map((se, i) => se.name || `Series ${i + 1}`);

/** Whether the bars stack: asked for, and more than one series to stack. */
export const isStacked = (s: ChartSpec) => s.type === "bar" && !!s.stacked && s.series.length > 1;

/** Each x's stack of bars: [start, end] per series, positives up from 0 and negatives down. */
export function stackSpans(s: ChartSpec): ([number, number] | null)[][] {
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

/** The sum at each x, or null where every series is a gap. */
export const stackTotals = (s: ChartSpec) =>
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
