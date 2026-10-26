import {
  chartValue,
  isStacked,
  niceTicks,
  type SeriesChart,
  seriesNames,
  stackSpans,
  stackTotals,
} from "@hatbot/shared";
import { CHAR_W, color, cutTo, Plot, TipRow, usePlot } from "./frame";

const PLOT_H = 150;
const TOP = 8;
const AXIS_H = 22;
export const HEIGHT = TOP + PLOT_H + AXIS_H;

export function SeriesPlot({ spec }: { spec: SeriesChart }) {
  return spec.type === "bar" && spec.horizontal ? <Rows spec={spec} /> : <Columns spec={spec} />;
}

/** What the value axis must cover: the values, and the reference lines. */
const plotted = (spec: SeriesChart, spans: ([number, number] | null)[][]) => [
  ...(isStacked(spec)
    ? spans.flat().flatMap((sp) => sp ?? [])
    : spec.series.flatMap((s) => s.data).filter((v): v is number => v !== null)),
  ...(spec.refs ?? []).map((r) => r.value),
];
const REF_H = 16;

function Columns({ spec }: { spec: SeriesChart }) {
  const labels = spec.x.map(String);
  const n = labels.length;
  const p = usePlot(n, "ArrowLeft", "ArrowRight");
  const { width, at, dim } = p;
  const bar = spec.type === "bar";
  const stacked = isStacked(spec);
  const spans = stacked ? stackSpans(spec) : [];
  const single = spec.series.length === 1;
  const fmt = (v: number, compact = false) => chartValue(v, spec.unit, compact);

  const values = plotted(spec, spans);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (bar) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const ticks = niceTicks(lo, hi);
  const bottom = ticks[0] as number;
  const top = ticks.at(-1) as number;

  const tickText = ticks.map((t) => fmt(t, true));
  const left = Math.max(...tickText.map((t) => t.length)) * CHAR_W + 8;
  const lastOf = (data: (number | null)[]) => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i] !== null) return i;
    return -1;
  };
  const first = spec.series[0]?.data ?? [];
  const end = lastOf(first);
  const endValue = first[end] ?? 0;
  const endLabel = !bar && single ? fmt(endValue) : null;
  const right = endLabel ? endLabel.length * CHAR_W + 12 : 6;
  const plotW = Math.max(40, width - left - right);

  const y = (v: number) => TOP + PLOT_H - ((v - bottom) / (top - bottom || 1)) * PLOT_H;
  const band = plotW / n;
  const x = (i: number) =>
    bar ? left + band * (i + 0.5) : left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));

  // Bars label every category, cut to fit its band, while that leaves a word; otherwise every
  // step-th x, as many as fit.
  const room = Math.floor((band - 8) / CHAR_W);
  const every = bar && room >= 4;
  const cut = every ? Math.min(12, room) : 12;
  const labelW = Math.min(Math.max(...labels.map((l) => l.length)), cut) * CHAR_W + 10;
  const step = every ? 1 : Math.ceil(n / Math.max(1, Math.floor(plotW / labelW)));
  const shown = labels.map((_, i) => i).filter((i) => i % step === 0);

  const indexAt = (px: number) => {
    const i = bar ? Math.floor((px - left) / band) : Math.round(((px - left) / plotW) * (n - 1));
    return Math.min(n - 1, Math.max(0, n === 1 ? 0 : i));
  };

  const k = stacked ? 1 : spec.series.length;
  const groupW = Math.min(band * 0.72, 24 * k + 2 * (k - 1));
  const barW = Math.max(1, Math.min(24, (groupW - 2 * (k - 1)) / k));

  return (
    <Plot
      {...frame(spec)}
      p={p}
      height={HEIGHT}
      pick={indexAt}
      tip={(i) => (x(i) < width / 2 ? { left: x(i) + 12 } : { right: width - x(i) + 12 })}
    >
      {ticks.map((t, i) => (
        <g key={t}>
          <line
            x1={left}
            x2={left + plotW}
            y1={y(t)}
            y2={y(t)}
            className={bar && t === 0 ? "baseline" : "grid"}
          />
          <text x={left - 8} y={y(t)} className="tick y">
            {tickText[i]}
          </text>
        </g>
      ))}
      {spec.refs?.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two lines can share a value
        <g key={i}>
          <line x1={left} x2={left + plotW} y1={y(r.value)} y2={y(r.value)} className="ref" />
          <text x={left + plotW} y={y(r.value) - 7} className="tick ref" textAnchor="end">
            {r.label}
          </text>
        </g>
      ))}
      {shown.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={HEIGHT - 6}
          className="tick x"
          textAnchor={
            bar || n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"
          }
        >
          {cutTo(labels[i] as string, cut)}
        </text>
      ))}
      {stacked &&
        spans.map((stack, i) =>
          segments(stack, y).map((sg) => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
              key={`${sg.si}-${i}`}
              d={barPath(x(i) - barW / 2, barW, sg.base, sg.end, sg.outer ? 4 : 0)}
              fill={color(sg.si)}
              opacity={dim(i)}
            />
          )),
        )}
      {bar &&
        !stacked &&
        spec.series.map((s, si) =>
          s.data.map((v, i) => {
            if (v === null || v === 0) return null;
            const bx = x(i) - groupW / 2 + si * (barW + 2) + (groupW - k * barW - 2 * (k - 1)) / 2;
            return (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
                key={`${si}-${i}`}
                d={barPath(bx, barW, y(0), y(v))}
                fill={color(si)}
                opacity={dim(i)}
              />
            );
          }),
        )}
      {!bar &&
        spec.series.map((s, si) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: series are positional, and two can share a name
          <g key={si}>
            <path d={linePath(s.data, x, y)} stroke={color(si)} className="line" />
            {s.data.map((v, i) =>
              v !== null && s.data[i - 1] == null && s.data[i + 1] == null ? (
                // A point with gaps both sides has no line to show it.
                // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
                <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={color(si)} />
              ) : null,
            )}
          </g>
        ))}
      {!bar && at !== null && (
        <line x1={x(at)} x2={x(at)} y1={TOP} y2={TOP + PLOT_H} className="crosshair" />
      )}
      {!bar &&
        spec.series.map((s, si) => {
          const i = at ?? lastOf(s.data);
          const v = s.data[i];
          if (v == null) return null;
          return (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: series are positional, and two can share a name
              key={si}
              cx={x(i)}
              cy={y(v)}
              r={4}
              fill={color(si)}
              className="dot"
            />
          );
        })}
      {endLabel && (
        <text x={x(end) + 9} y={y(endValue)} className="end">
          {endLabel}
        </text>
      )}
    </Plot>
  );
}

const ROW_GAP = 10;

function Rows({ spec }: { spec: SeriesChart }) {
  const labels = spec.x.map(String);
  const n = labels.length;
  const p = usePlot(n, "ArrowUp", "ArrowDown");
  const { width, dim } = p;
  const stacked = isStacked(spec);
  const spans = stacked ? stackSpans(spec) : [];
  const totals = stacked ? stackTotals(spec) : [];
  const fmt = (v: number) => chartValue(v, spec.unit);

  const k = stacked ? 1 : spec.series.length;
  const thick = k === 1 ? 14 : 10;
  const rowH = k * thick + 2 * (k - 1) + ROW_GAP;
  // The reference lines' labels go above the rows.
  const refTop = spec.refs?.length ? REF_H : 0;
  const height = refTop + n * rowH;

  const values = plotted(spec, spans);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const tips: (number | null)[][] = stacked
    ? totals.map((t) => [t])
    : labels.map((_, i) => spec.series.map((s) => s.data[i] ?? null));
  const tipW = (neg: boolean) =>
    Math.max(
      0,
      ...tips.flat().map((v) => (v !== null && v < 0 === neg ? fmt(v).length * CHAR_W + 8 : 0)),
    );

  const cut = Math.max(4, Math.min(18, Math.floor((width * 0.4 - 10) / CHAR_W)));
  const left = Math.min(Math.max(...labels.map((l) => l.length)), cut) * CHAR_W + 10;
  const negRoom = lo < 0 ? tipW(true) : 0;
  const plotW = Math.max(40, width - left - negRoom - tipW(false));
  const v = (val: number) => left + negRoom + ((val - lo) / (hi - lo || 1)) * plotW;
  const rowTop = (i: number) => refTop + i * rowH + ROW_GAP / 2;

  const tip = (val: number, cy: number, end: number, key: string) => (
    <text
      key={key}
      x={val < 0 ? end - 6 : end + 6}
      y={cy}
      className="end"
      textAnchor={val < 0 ? "end" : "start"}
    >
      {fmt(val)}
    </text>
  );

  return (
    <Plot
      {...frame(spec)}
      p={p}
      height={height}
      pick={(_, py) => Math.min(n - 1, Math.max(0, Math.floor((py - refTop) / rowH)))}
      tip={(i) =>
        rowTop(i) + rowH < height / 2 || n < 4
          ? { left, top: rowTop(i) + rowH }
          : { left, top: "auto", bottom: height - rowTop(i) + 4 }
      }
    >
      {labels.map((l, i) => (
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          key={i}
          x={0}
          y={rowTop(i) + (rowH - ROW_GAP) / 2}
          className="tick row"
        >
          {cutTo(l, cut)}
        </text>
      ))}
      <line x1={v(0)} x2={v(0)} y1={refTop} y2={height} className="baseline" />
      {spec.refs?.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two lines can share a value
        <g key={i}>
          <line x1={v(r.value)} x2={v(r.value)} y1={refTop - 2} y2={height} className="ref" />
          <text x={v(r.value)} y={REF_H / 2 - 2} className="tick ref" textAnchor="middle">
            {r.label}
          </text>
        </g>
      ))}
      {stacked &&
        spans.map((stack, i) => {
          const cy = rowTop(i) + thick / 2;
          const total = totals[i];
          const ends = stack.filter((sp) => sp !== null).map((sp) => sp[1]);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <g key={i} opacity={dim(i)}>
              {segments(stack, v).map((sg) => (
                <path
                  key={sg.si}
                  d={hbarPath(rowTop(i), thick, sg.base, sg.end, sg.outer ? 4 : 0)}
                  fill={color(sg.si)}
                />
              ))}
              {total != null &&
                tip(total, cy, v(total < 0 ? Math.min(...ends) : Math.max(...ends)), "t")}
            </g>
          );
        })}
      {!stacked &&
        labels.map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <g key={i} opacity={dim(i)}>
            {spec.series.map((s, si) => {
              const val = s.data[i];
              if (val == null) return null;
              const top = rowTop(i) + si * (thick + 2);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: series are positional, and two can share a name
                <g key={si}>
                  {val !== 0 && <path d={hbarPath(top, thick, v(0), v(val), 4)} fill={color(si)} />}
                  {tip(val, top + thick / 2, v(val), "t")}
                </g>
              );
            })}
          </g>
        ))}
    </Plot>
  );
}

/**
 * A stack's segments, in pixels along `at`: a 2px gap from the segment below, and only the stack's
 * outer ends rounded. One too thin to see is left out.
 */
function segments(stack: ([number, number] | null)[], at: (v: number) => number) {
  const up = Math.sign(at(1) - at(0));
  return stack.flatMap((sp, si) => {
    if (!sp) return [];
    const [from, to] = sp;
    const base = from === 0 ? at(0) : at(from) + (to > 0 ? 2 : -2) * up;
    const outer = !stack.slice(si + 1).some((o) => o && o[1] > 0 === to > 0);
    return Math.abs(base - at(to)) < 1 ? [] : [{ si, base, end: at(to), outer }];
  });
}

function readout(spec: SeriesChart, i: number) {
  const names = seriesNames(spec);
  const single = spec.series.length === 1;
  const fmt = (v: number) => chartValue(v, spec.unit);
  const total = isStacked(spec) ? stackTotals(spec)[i] : null;
  return (
    <>
      <div className="chart-tip-x">{String(spec.x[i])}</div>
      {spec.series.map((s, si) => (
        <TipRow
          // biome-ignore lint/suspicious/noArrayIndexKey: series are positional, and two can share a name
          key={si}
          mark={color(si)}
          value={s.data[i] == null ? "–" : fmt(s.data[i] as number)}
          name={single ? undefined : names[si]}
        />
      ))}
      {total != null && <TipRow className="total" value={fmt(total)} name="total" />}
    </>
  );
}

function frame(spec: SeriesChart) {
  const names = seriesNames(spec);
  const fmt = (v: number | null) => (v === null ? "" : chartValue(v, spec.unit));
  return {
    title: spec.title,
    legend:
      spec.series.length > 1
        ? names.map((name, i) => ({
            name,
            shape: spec.type === "bar" ? ("swatch" as const) : ("key" as const),
            color: color(i),
          }))
        : undefined,
    readout: (i: number) => readout(spec, i),
    table: {
      head: ["", ...names],
      rows: spec.x.map((x, i) => [String(x), ...spec.series.map((s) => fmt(s.data[i] ?? null))]),
    },
  };
}

/** A line through the values, lifting the pen over gaps. */
function linePath(data: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  let d = "";
  let pen = false;
  data.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function barPath(x: number, w: number, base: number, end: number, radius = 4) {
  const up = end < base;
  const r = Math.min(radius, w / 2, Math.abs(base - end));
  const e = up ? end + r : end - r;
  return [
    `M${x},${base}`,
    `V${e}`,
    `Q${x},${end} ${x + r},${end}`,
    `H${x + w - r}`,
    `Q${x + w},${end} ${x + w},${e}`,
    `V${base}`,
    "Z",
  ].join(" ");
}

function hbarPath(y: number, h: number, base: number, end: number, radius: number) {
  const right = end > base;
  const r = Math.min(radius, h / 2, Math.abs(base - end));
  const e = right ? end - r : end + r;
  return [
    `M${base},${y}`,
    `H${e}`,
    `Q${end},${y} ${end},${y + r}`,
    `V${y + h - r}`,
    `Q${end},${y + h} ${e},${y + h}`,
    `H${base}`,
    "Z",
  ].join(" ");
}
