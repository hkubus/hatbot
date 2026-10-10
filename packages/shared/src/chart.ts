// Charts in replies: a ```chart fenced block holding this JSON. The clients draw it in Hatbot's own
// style; anywhere else (Copy, search, an older client) it stays a readable code block.
import { z } from "zod";

/** Past three series the colours stop telling apart for colour-blind readers. */
export const CHART_MAX_SERIES = 3;
export const CHART_MAX_POINTS = 500;

export const ChartSpec = z
  .object({
    type: z.enum(["line", "bar"]),
    title: z.string().max(120).optional(),
    /** "%", "GiB", "ms", or a currency symbol ("$", "€"), which goes in front. */
    unit: z.string().max(12).optional(),
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

/** Series names, with "Series 2" for one Hatbot left unnamed. */
export const seriesNames = (s: ChartSpec) => s.series.map((se, i) => se.name || `Series ${i + 1}`);

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
