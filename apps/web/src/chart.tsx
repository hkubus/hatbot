// A ```chart block in a reply, drawn as SVG in Hatbot's colours: a line or bar chart with a hover
// readout (crosshair on lines, the bar itself on bars) that also follows the arrow keys.
import { type ChartSpec, chartValue, niceTicks, seriesNames } from "@hatbot/shared";
import { useLayoutEffect, useRef, useState } from "react";

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
  const plot = useRef<HTMLDivElement>(null);
  const width = useWidth(plot);
  const [at, setAt] = useState<number | null>(null);
  const names = seriesNames(spec);
  const labels = spec.x.map(String);
  const n = labels.length;
  const bar = spec.type === "bar";
  const single = spec.series.length === 1;
  const fmt = (v: number, compact = false) => chartValue(v, spec.unit, compact);

  const values = spec.series.flatMap((s) => s.data).filter((v): v is number => v !== null);
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

  const k = spec.series.length;
  const groupW = Math.min(band * 0.72, 24 * k + 2 * (k - 1));
  const barW = Math.max(1, Math.min(24, (groupW - 2 * (k - 1)) / k));

  return (
    <figure className="chart">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      {!single && (
        <div className="chart-legend">
          {names.map((name, i) => (
            <span key={name}>
              <i className={bar ? "swatch" : "key"} style={{ background: color(i) }} />
              {name}
            </span>
          ))}
        </div>
      )}
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
            {bar &&
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
          <div
            className="chart-tip"
            style={x(at) < width / 2 ? { left: x(at) + 12 } : { right: width - x(at) + 12 }}
          >
            <div className="chart-tip-x">{labels[at]}</div>
            {spec.series.map((s, si) => (
              <div key={names[si]} className="chart-tip-row">
                <i className="key" style={{ background: color(si) }} />
                <strong>{s.data[at] === null ? "–" : fmt(s.data[at] as number)}</strong>
                {!single && <span>{names[si]}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
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
function barPath(x: number, w: number, base: number, end: number) {
  const up = end < base;
  const r = Math.min(4, w / 2, Math.abs(base - end));
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
