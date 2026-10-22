import { chartValue, niceTicks, type RangeChart } from "@hatbot/shared";
import { CHAR_W, clamp, color, cutTo, Plot, TipRow, usePlot } from "./frame";

const THICK = 14;
const ROW_H = 24;
const NARROW = 440;
const NAMED_ROW_H = 40;
const AXIS_H = 22;
/** The mark's colour: ink, so it stands out of the bar in either theme. */
const MARK = "var(--text)";

export function RangePlot({ spec }: { spec: RangeChart }) {
  const { rows } = spec;
  const n = rows.length;
  const p = usePlot(n, "ArrowUp", "ArrowDown");
  const { width, dim } = p;
  const fmt = (v: number, compact = false) => chartValue(v, spec.unit, compact);
  const hasMark = rows.some((r) => r.mark !== undefined);
  const markName = spec.markName ?? "mark";

  const narrow = width < NARROW;
  const rowH = narrow ? NAMED_ROW_H : ROW_H;
  const cut = narrow
    ? Math.floor(width / CHAR_W)
    : clamp(Math.floor((width * 0.35 - 10) / CHAR_W), 4, 18);
  const left = narrow
    ? 0
    : Math.min(Math.max(...rows.map((r) => r.label.length)), cut) * CHAR_W + 10;
  const lowW = Math.max(...rows.map((r) => fmt(r.low).length)) * CHAR_W + 8;
  const highW = Math.max(...rows.map((r) => fmt(r.high).length)) * CHAR_W + 8;
  const plotX = left + lowW;
  const plotW = Math.max(40, width - plotX - highW);
  // The axis spans the values, not zero: ranges float. Ticks are the round values inside it.
  const lo = Math.min(...rows.map((r) => r.low));
  const hi = Math.max(...rows.map((r) => r.high));
  const ticks = niceTicks(lo, hi, Math.max(2, Math.floor(plotW / 50))).filter(
    (t) => t >= lo && t <= hi,
  );
  const v = (val: number) => plotX + (hi > lo ? ((val - lo) / (hi - lo)) * plotW : plotW / 2);
  const plotH = n * rowH;
  const height = plotH + AXIS_H;
  const mid = (i: number) => i * rowH + (narrow ? 27 : rowH / 2);

  return (
    <Plot
      title={spec.title}
      legend={hasMark ? [{ name: markName, shape: "point", color: MARK }] : undefined}
      p={p}
      height={height}
      pick={(_, py) => clamp(Math.floor(py / rowH), 0, n - 1)}
      tip={(i) =>
        mid(i) < plotH / 2 || n < 4
          ? { left, top: (i + 1) * rowH }
          : { left, top: "auto", bottom: height - i * rowH + 4 }
      }
      readout={(i) => {
        const r = rows[i] as RangeChart["rows"][number];
        return (
          <>
            <div className="chart-tip-x">{r.label}</div>
            <TipRow value={`${fmt(r.low)} – ${fmt(r.high)}`} />
            {r.mark !== undefined && <TipRow value={fmt(r.mark)} name={markName} />}
          </>
        );
      }}
      table={{
        head: ["", "Low", "High", ...(hasMark ? [markName] : [])],
        rows: rows.map((r) => [
          r.label,
          fmt(r.low),
          fmt(r.high),
          ...(hasMark ? [r.mark === undefined ? "" : fmt(r.mark)] : []),
        ]),
      }}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={v(t)} x2={v(t)} y1={0} y2={plotH} className="grid" />
          <text x={v(t)} y={height - 6} className="tick x" textAnchor="middle">
            {fmt(t, true)}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const cy = mid(i);
        // A range with no width still shows, as a short pill.
        const [x0, x1] =
          v(r.high) - v(r.low) < 4 ? [v(r.low) - 2, v(r.low) + 2] : [v(r.low), v(r.high)];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <g key={i} opacity={dim(i)}>
            <text x={0} y={narrow ? cy - 18 : cy} className="tick row">
              {cutTo(r.label, cut)}
            </text>
            <rect
              x={x0}
              y={cy - THICK / 2}
              width={x1 - x0}
              height={THICK}
              rx={Math.min(4, (x1 - x0) / 2)}
              fill={color(0)}
            />
            <text x={x0 - 6} y={cy} className="end" textAnchor="end">
              {fmt(r.low)}
            </text>
            {r.high !== r.low && (
              <text x={x1 + 6} y={cy} className="end">
                {fmt(r.high)}
              </text>
            )}
            {r.mark !== undefined && (
              <circle cx={v(r.mark)} cy={cy} r={4} fill={MARK} className="dot" />
            )}
          </g>
        );
      })}
    </Plot>
  );
}
