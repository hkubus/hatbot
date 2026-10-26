import { chartValue, niceTicks, type OffersChart } from "@hatbot/shared";
import { CHAR_W, color, Plot, TipRow, tipBeside, usePlot } from "./frame";

const PLOT_H = 150;
const TOP = 8;
const AXIS_H = 22;
const HEIGHT = TOP + PLOT_H + AXIS_H;

export function OffersPlot({ spec }: { spec: OffersChart }) {
  const { offers } = spec;
  const n = offers.length;
  const p = usePlot(n, "ArrowLeft", "ArrowRight");
  const { width, at, dim } = p;
  const fmt = (v: number, compact = false) => chartValue(v, spec.unit, compact);
  const them = spec.them ?? "Them";
  const side = (by: "you" | "them") => (by === "you" ? 0 : 1);

  const values = [...offers.map((o) => o.price), ...(spec.limit === undefined ? [] : [spec.limit])];
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const bottom = ticks[0] as number;
  const top = ticks.at(-1) as number;
  const tickText = ticks.map((t) => fmt(t, true));
  const left = Math.max(...tickText.map((t) => t.length)) * CHAR_W + 8;
  const plotW = Math.max(40, width - left - 10);
  const x = (i: number) => left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => TOP + PLOT_H - ((v - bottom) / (top - bottom || 1)) * PLOT_H;
  const path = (by: "you" | "them") =>
    offers
      .flatMap((o, i) => (o.by === by ? [`${x(i).toFixed(1)},${y(o.price).toFixed(1)}`] : []))
      .map((pt, k) => `${k ? "L" : "M"}${pt}`)
      .join("");
  const step = Math.ceil(n / Math.max(1, Math.floor(plotW / 28)));

  return (
    <Plot
      title={spec.title}
      legend={[
        { name: "You", shape: "key", color: color(0) },
        { name: them, shape: "key", color: color(1) },
      ]}
      p={p}
      height={HEIGHT}
      pick={(px) =>
        Math.min(n - 1, Math.max(0, n === 1 ? 0 : Math.round(((px - left) / plotW) * (n - 1))))
      }
      tip={(i) => tipBeside(x(i), width)}
      readout={(i) => {
        const o = offers[i] as OffersChart["offers"][number];
        return (
          <>
            <div className="chart-tip-x">Turn {i + 1}</div>
            <TipRow
              mark={color(side(o.by))}
              value={fmt(o.price)}
              name={o.by === "you" ? "You" : them}
            />
            {o.note && <div className="chart-tip-x">{o.note}</div>}
          </>
        );
      }}
      table={{
        head: ["Turn", "Who", "Price", ""],
        rows: offers.map((o, i) => [
          String(i + 1),
          o.by === "you" ? "You" : them,
          fmt(o.price),
          o.note ?? "",
        ]),
      }}
    >
      {ticks.map((t, i) => (
        <g key={t}>
          <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} className="grid" />
          <text x={left - 8} y={y(t)} className="tick y">
            {tickText[i]}
          </text>
        </g>
      ))}
      {offers.map((_, i) =>
        i % step === 0 || i === n - 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are positional
          <text key={i} x={x(i)} y={HEIGHT - 6} className="tick x" textAnchor="middle">
            {i + 1}
          </text>
        ) : null,
      )}
      {spec.limit !== undefined && (
        <g>
          <line x1={left} x2={left + plotW} y1={y(spec.limit)} y2={y(spec.limit)} className="ref" />
          <text x={left + plotW} y={y(spec.limit) - 7} className="tick ref" textAnchor="end">
            Limit
          </text>
        </g>
      )}
      <path d={path("you")} stroke={color(0)} className="line" />
      <path d={path("them")} stroke={color(1)} className="line" />
      {offers.map((o, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are positional
          key={i}
          cx={x(i)}
          cy={y(o.price)}
          r={at === i ? 5 : 3.5}
          fill={color(side(o.by))}
          opacity={dim(i)}
          className="dot"
        />
      ))}
    </Plot>
  );
}
