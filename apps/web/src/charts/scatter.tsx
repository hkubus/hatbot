// Points on two measured axes. A few points are named beside themselves where there's room; the
// readout names the one nearest the pointer, and the arrow keys walk them left to right.
import { chartValue, niceTicks, type ScatterChart, seriesNames } from "@hatbot/shared";
import { CHAR_W, color, cutTo, Plot, TipRow, tipBeside, usePlot } from "./frame";

const PLOT_H = 190;
const AXIS_H = 22;
/** Room for an axis's name: the y's above the plot, the x's below its ticks. */
const NAME_H = 16;
/** Up to this many points are each named on the plot. */
const LABEL_MAX = 12;
/** How near the pointer has to be to a point to pick it. */
const REACH = 24;

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function ScatterPlot({ spec }: { spec: ScatterChart }) {
  const names = seriesNames(spec);
  const multi = spec.series.length > 1;
  const pts = spec.series
    .flatMap((se, si) => se.points.map((pt) => ({ ...pt, si })))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const n = pts.length;
  const p = usePlot(n, "ArrowLeft", "ArrowRight");
  const { width, at, dim } = p;
  const fx = (v: number, compact = false) => chartValue(v, spec.xUnit, compact);
  const fy = (v: number, compact = false) => chartValue(v, spec.yUnit, compact);

  const top = spec.yName ? NAME_H + 6 : 8;
  const height = top + PLOT_H + AXIS_H + (spec.xName ? NAME_H : 0);
  const yTicks = niceTicks(Math.min(...pts.map((pt) => pt.y)), Math.max(...pts.map((pt) => pt.y)));
  const yText = yTicks.map((t) => fy(t, true));
  const left = Math.max(...yText.map((t) => t.length)) * CHAR_W + 8;
  // Fewer x ticks on a phone; the last one's label is centred on the plot's right edge.
  const xs = pts.map((pt) => pt.x);
  const guess = Math.max(2, Math.floor((width - left) / 80));
  const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), guess);
  const xText = xTicks.map((t) => fx(t, true));
  const right = ((xText.at(-1)?.length ?? 0) * CHAR_W) / 2 + 2;
  const plotW = Math.max(40, width - left - right);

  const [xLo, xHi] = [xTicks[0] as number, xTicks.at(-1) as number];
  const [yLo, yHi] = [yTicks[0] as number, yTicks.at(-1) as number];
  const x = (v: number) => left + ((v - xLo) / (xHi - xLo || 1)) * plotW;
  const y = (v: number) => top + PLOT_H - ((v - yLo) / (yHi - yLo || 1)) * PLOT_H;

  // Names beside their points, each on the first side where it hits nothing drawn so far.
  const labels: { i: number; x: number; y: number; anchor: "start" | "middle" | "end" }[] = [];
  if (n <= LABEL_MAX) {
    const taken: Box[] = pts.map((pt) => {
      const [cx, cy] = [x(pt.x), y(pt.y)];
      return { x0: cx - 5, y0: cy - 5, x1: cx + 5, y1: cy + 5 };
    });
    const room = { x0: 0, y0: 0, x1: width, y1: top + PLOT_H + 4 };
    pts.forEach((pt, i) => {
      if (!pt.label) return;
      const [cx, cy] = [x(pt.x), y(pt.y)];
      const w = cutTo(pt.label, 18).length * CHAR_W;
      const sides = [
        { x: cx + 8, y: cy, anchor: "start" as const, box: { x0: cx + 7, x1: cx + 9 + w } },
        { x: cx - 8, y: cy, anchor: "end" as const, box: { x0: cx - 9 - w, x1: cx - 7 } },
        { x: cx, y: cy - 12, anchor: "middle" as const, box: { x0: cx - w / 2, x1: cx + w / 2 } },
        { x: cx, y: cy + 12, anchor: "middle" as const, box: { x0: cx - w / 2, x1: cx + w / 2 } },
      ];
      for (const side of sides) {
        const box = { ...side.box, y0: side.y - 7, y1: side.y + 7 };
        const inside =
          box.x0 >= room.x0 && box.x1 <= room.x1 && box.y0 >= room.y0 && box.y1 <= room.y1;
        if (!inside || taken.some((t) => overlaps(t, box))) continue;
        taken.push(box);
        labels.push({ i, x: side.x, y: side.y, anchor: side.anchor });
        break;
      }
    });
  }

  const pick = (px: number, py: number) => {
    let best: number | null = null;
    let bestD = REACH;
    pts.forEach((pt, i) => {
      const d = Math.hypot(x(pt.x) - px, y(pt.y) - py);
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  };

  const hot = at === null ? undefined : pts[at];
  const xName = spec.xName ?? "x";
  const yName = spec.yName ?? "y";
  const ticksY = top + PLOT_H + 14;
  return (
    <Plot
      title={spec.title}
      legend={
        multi ? names.map((name, i) => ({ name, shape: "point", color: color(i) })) : undefined
      }
      p={p}
      height={height}
      pick={pick}
      tip={(i) => {
        const pt = pts[i] as (typeof pts)[number];
        const cy = y(pt.y);
        return cy < top + PLOT_H / 2
          ? tipBeside(x(pt.x), width, cy + 8)
          : { ...tipBeside(x(pt.x), width), top: "auto", bottom: height - cy + 8 };
      }}
      readout={(i) => {
        const pt = pts[i] as (typeof pts)[number];
        const head = [pt.label, multi ? names[pt.si] : undefined].filter(Boolean).join(" · ");
        return (
          <>
            {head && <div className="chart-tip-x">{head}</div>}
            <TipRow value={fx(pt.x)} name={xName} mark={multi ? color(pt.si) : undefined} />
            {/* Lined up under the row above, past its key. */}
            <TipRow className={multi ? "total" : undefined} value={fy(pt.y)} name={yName} />
          </>
        );
      }}
      table={{
        head: ["", ...(multi ? [""] : []), xName, yName],
        rows: pts.map((pt) => [
          pt.label ?? "",
          ...(multi ? [names[pt.si] as string] : []),
          fx(pt.x),
          fy(pt.y),
        ]),
      }}
    >
      {spec.yName && (
        <text x={0} y={NAME_H / 2} className="tick name">
          {spec.yName}
        </text>
      )}
      {yTicks.map((t, i) => (
        <g key={t}>
          <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className="grid" />
          <text x={left - 8} y={y(t)} className="tick y">
            {yText[i]}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top} y2={top + PLOT_H} className="grid" />
          <text x={x(t)} y={ticksY} className="tick x" textAnchor="middle">
            {xText[i]}
          </text>
        </g>
      ))}
      {spec.xName && (
        <text x={left + plotW} y={ticksY + NAME_H} className="tick name" textAnchor="end">
          {spec.xName}
        </text>
      )}
      {pts.map((pt, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
          key={i}
          cx={x(pt.x)}
          cy={y(pt.y)}
          r={4}
          fill={color(pt.si)}
          className="dot"
          opacity={dim(i)}
        />
      ))}
      {labels.map((l) => (
        <text key={l.i} x={l.x} y={l.y} className="end" textAnchor={l.anchor} opacity={dim(l.i)}>
          {cutTo(pts[l.i]?.label ?? "", 18)}
        </text>
      ))}
      {hot && <circle cx={x(hot.x)} cy={y(hot.y)} r={5.5} fill={color(hot.si)} className="dot" />}
    </Plot>
  );
}
