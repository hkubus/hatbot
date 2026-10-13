// A ```chart block in a reply, drawn as SVG in Hatbot's colours: lines, columns (grouped or
// stacked) or horizontal bars, with a hover readout (crosshair on lines, the bar itself on bars)
// that also follows the arrow keys.
import {
  type ChartSpec,
  chartValue,
  isStacked,
  niceTicks,
  seriesNames,
  stackSpans,
  stackTotals,
} from "@hatbot/shared";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

const PLOT_H = 150;
const TOP = 8;
const AXIS_H = 22;
const HEIGHT = TOP + PLOT_H + AXIS_H;
/** Rough width of an 11px digit or letter, for room beside the plot. */
const CHAR_W = 6.2;

const color = (i: number) => `var(--series-${i + 1})`;

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Same footprint as the chart, while its block is still streaming in. */
export function ChartPending() {
  return <div className="chart pending" style={{ height: HEIGHT }} />;
}

export function Chart({ spec }: { spec: ChartSpec }) {
  return spec.type === "bar" && spec.horizontal ? <Rows spec={spec} /> : <Columns spec={spec} />;
}

/** Lines, or columns side by side or stacked. */
function Columns({ spec }: { spec: ChartSpec }) {
  const plot = useRef<HTMLDivElement>(null);
  const width = useWidth(plot);
  const [at, setAt] = useState<number | null>(null);
  const names = seriesNames(spec);
  const labels = spec.x.map(String);
  const n = labels.length;
  const bar = spec.type === "bar";
  const stacked = isStacked(spec);
  const spans = stacked ? stackSpans(spec) : [];
  const single = spec.series.length === 1;
  const fmt = (v: number, compact = false) => chartValue(v, spec.unit, compact);

  const values = stacked
    ? spans.flat().flatMap((sp) => sp ?? [])
    : spec.series.flatMap((s) => s.data).filter((v): v is number => v !== null);
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
  // One line gets its last value beside its end.
  const lastOf = (data: (number | null)[]) => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i] !== null) return i;
    return -1;
  };
  const endLabel =
    !bar && single ? fmt(spec.series[0]?.data[lastOf(spec.series[0]?.data ?? [])] ?? 0) : null;
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
  const short = (l: string) => (l.length > cut ? `${l.slice(0, cut - 1)}…` : l);

  const indexAt = (px: number) => {
    const i = bar ? Math.floor((px - left) / band) : Math.round(((px - left) / plotW) * (n - 1));
    return Math.min(n - 1, Math.max(0, n === 1 ? 0 : i));
  };
  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(indexAt(e.clientX - box.left));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    setAt((i) => Math.min(n - 1, Math.max(0, i === null ? (step > 0 ? 0 : n - 1) : i + step)));
  };

  const k = stacked ? 1 : spec.series.length;
  const groupW = Math.min(band * 0.72, 24 * k + 2 * (k - 1));
  const barW = Math.max(1, Math.min(24, (groupW - 2 * (k - 1)) / k));

  return (
    <Frame spec={spec}>
      <div className="chart-plot" ref={plot}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={spec.title ?? "Chart"}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move the readout; the hidden table carries the values for screen readers
            tabIndex={0}
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={(e) => e.pointerType === "mouse" && setAt(null)}
            onKeyDown={onKey}
            onBlur={() => setAt(null)}
            onClick={(e) => e.stopPropagation()}
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
                {short(labels[i] as string)}
              </text>
            ))}
            {stacked &&
              spans.map((stack, i) =>
                stack.map((sp, si) => {
                  if (!sp) return null;
                  const [from, to] = sp;
                  const bx = x(i) - barW / 2;
                  // A 2px gap from the segment below; only the stack's outer ends are rounded.
                  const base = from === 0 ? y(0) : y(from) + (to > 0 ? -2 : 2);
                  const outer = !stack.slice(si + 1).some((o) => o && o[1] > 0 === to > 0);
                  if (Math.abs(base - y(to)) < 1) return null;
                  return (
                    <path
                      // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
                      key={`${si}-${i}`}
                      d={barPath(bx, barW, base, y(to), outer ? 4 : 0)}
                      fill={color(si)}
                      opacity={at === null || at === i ? 1 : 0.45}
                    />
                  );
                }),
              )}
            {bar &&
              !stacked &&
              spec.series.map((s, si) =>
                s.data.map((v, i) => {
                  if (v === null || v === 0) return null;
                  const bx =
                    x(i) - groupW / 2 + si * (barW + 2) + (groupW - k * barW - 2 * (k - 1)) / 2;
                  return (
                    <path
                      // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
                      key={`${si}-${i}`}
                      d={barPath(bx, barW, y(0), y(v))}
                      fill={color(si)}
                      opacity={at === null || at === i ? 1 : 0.45}
                    />
                  );
                }),
              )}
            {!bar &&
              spec.series.map((s, si) => (
                <g key={names[si]}>
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
                    key={names[si]}
                    cx={x(i)}
                    cy={y(v)}
                    r={4}
                    fill={color(si)}
                    className="dot"
                  />
                );
              })}
            {endLabel && (
              <text
                x={x(lastOf(spec.series[0]?.data ?? [])) + 9}
                y={y(spec.series[0]?.data[lastOf(spec.series[0]?.data ?? [])] ?? 0)}
                className="end"
              >
                {endLabel}
              </text>
            )}
          </svg>
        )}
        {at !== null && (
          <Readout
            spec={spec}
            i={at}
            style={x(at) < width / 2 ? { left: x(at) + 12 } : { right: width - x(at) + 12 }}
          />
        )}
      </div>
    </Frame>
  );
}

const ROW_GAP = 10;

/** Horizontal bars, a row per x: names on the left, each bar's value (a stack's total) at its tip. */
function Rows({ spec }: { spec: ChartSpec }) {
  const plot = useRef<HTMLDivElement>(null);
  const width = useWidth(plot);
  const [at, setAt] = useState<number | null>(null);
  const names = seriesNames(spec);
  const labels = spec.x.map(String);
  const n = labels.length;
  const stacked = isStacked(spec);
  const spans = stacked ? stackSpans(spec) : [];
  const totals = stacked ? stackTotals(spec) : [];
  const fmt = (v: number) => chartValue(v, spec.unit);

  const k = stacked ? 1 : spec.series.length;
  const thick = k === 1 ? 14 : 10;
  const rowH = k * thick + 2 * (k - 1) + ROW_GAP;
  const height = n * rowH;

  const values = stacked
    ? spans.flat().flatMap((sp) => sp ?? [])
    : spec.series.flatMap((s) => s.data).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  // The labels at the tips, and room for the widest beyond each end.
  const tips: (number | null)[][] = stacked
    ? totals.map((t) => [t])
    : labels.map((_, i) => spec.series.map((s) => s.data[i] ?? null));
  const tipW = (neg: boolean) =>
    Math.max(
      0,
      ...tips.flat().map((v) => (v !== null && v < 0 === neg ? fmt(v).length * CHAR_W + 8 : 0)),
    );

  const cut = Math.max(4, Math.min(18, Math.floor((width * 0.4 - 10) / CHAR_W)));
  const short = (l: string) => (l.length > cut ? `${l.slice(0, cut - 1)}…` : l);
  const left = Math.min(Math.max(...labels.map((l) => l.length)), cut) * CHAR_W + 10;
  const negRoom = lo < 0 ? tipW(true) : 0;
  const plotW = Math.max(40, width - left - negRoom - tipW(false));
  const v = (val: number) => left + negRoom + ((val - lo) / (hi - lo || 1)) * plotW;
  const rowTop = (i: number) => i * rowH + ROW_GAP / 2;

  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(Math.min(n - 1, Math.max(0, Math.floor((e.clientY - box.top) / rowH))));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = e.key === "ArrowUp" ? -1 : 1;
    setAt((i) => Math.min(n - 1, Math.max(0, i === null ? (step > 0 ? 0 : n - 1) : i + step)));
  };
  const dim = (i: number) => (at === null || at === i ? 1 : 0.45);
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
    <Frame spec={spec}>
      <div className="chart-plot" ref={plot}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={spec.title ?? "Chart"}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move the readout; the hidden table carries the values for screen readers
            tabIndex={0}
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={(e) => e.pointerType === "mouse" && setAt(null)}
            onKeyDown={onKey}
            onBlur={() => setAt(null)}
            onClick={(e) => e.stopPropagation()}
          >
            {labels.map((l, i) => (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                key={i}
                x={0}
                y={rowTop(i) + (rowH - ROW_GAP) / 2}
                className="tick row"
              >
                {short(l)}
              </text>
            ))}
            <line x1={v(0)} x2={v(0)} y1={0} y2={height} className="baseline" />
            {stacked &&
              spans.map((stack, i) => {
                const cy = rowTop(i) + thick / 2;
                const total = totals[i];
                const ends = stack.filter((sp) => sp !== null).map((sp) => sp[1]);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                  <g key={i} opacity={dim(i)}>
                    {stack.map((sp, si) => {
                      if (!sp) return null;
                      const [from, to] = sp;
                      const base = from === 0 ? v(0) : v(from) + (to > 0 ? 2 : -2);
                      const outer = !stack.slice(si + 1).some((o) => o && o[1] > 0 === to > 0);
                      if (Math.abs(base - v(to)) < 1) return null;
                      return (
                        <path
                          key={names[si]}
                          d={hbarPath(rowTop(i), thick, base, v(to), outer ? 4 : 0)}
                          fill={color(si)}
                        />
                      );
                    })}
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
                      <g key={names[si]}>
                        {val !== 0 && (
                          <path d={hbarPath(top, thick, v(0), v(val), 4)} fill={color(si)} />
                        )}
                        {tip(val, top + thick / 2, v(val), "t")}
                      </g>
                    );
                  })}
                </g>
              ))}
          </svg>
        )}
        {at !== null && (
          <Readout
            spec={spec}
            i={at}
            style={
              rowTop(at) + rowH < height / 2 || n < 4
                ? { left, top: rowTop(at) + rowH }
                : { left, top: "auto", bottom: height - rowTop(at) + 4 }
            }
          />
        )}
      </div>
    </Frame>
  );
}

/** Title, legend, and the values as a table for screen readers, around the plot. */
function Frame({ spec, children }: { spec: ChartSpec; children: ReactNode }) {
  const names = seriesNames(spec);
  const labels = spec.x.map(String);
  const fmt = (v: number) => chartValue(v, spec.unit);
  return (
    <figure className="chart">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      {spec.series.length > 1 && (
        <div className="chart-legend">
          {names.map((name, i) => (
            <span key={name}>
              <i
                className={spec.type === "bar" ? "swatch" : "key"}
                style={{ background: color(i) }}
              />
              {name}
            </span>
          ))}
        </div>
      )}
      {children}
      <table className="sr-only">
        <thead>
          <tr>
            <th />
            {names.map((name) => (
              <th key={name}>{name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <tr key={i}>
              <th>{l}</th>
              {spec.series.map((s, si) => (
                <td key={names[si]}>{s.data[i] === null ? "" : fmt(s.data[i] as number)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The values at one x: value first, then the series; a stack adds its total. */
function Readout({ spec, i, style }: { spec: ChartSpec; i: number; style: React.CSSProperties }) {
  const names = seriesNames(spec);
  const single = spec.series.length === 1;
  const fmt = (v: number) => chartValue(v, spec.unit);
  const total = isStacked(spec) ? stackTotals(spec)[i] : null;
  return (
    <div className="chart-tip" style={style}>
      <div className="chart-tip-x">{String(spec.x[i])}</div>
      {spec.series.map((s, si) => (
        <div key={names[si]} className="chart-tip-row">
          <i className="key" style={{ background: color(si) }} />
          <strong>{s.data[i] == null ? "–" : fmt(s.data[i] as number)}</strong>
          {!single && <span>{names[si]}</span>}
        </div>
      ))}
      {total != null && (
        <div className="chart-tip-row total">
          <strong>{fmt(total)}</strong>
          <span>total</span>
        </div>
      )}
    </div>
  );
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

/** A bar from the baseline to its value: rounded at the value's end, square at the baseline. */
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

/** barPath turned on its side: from the baseline at x = base to x = end, at rows y to y + h. */
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
