import { chartValue, type TreemapChart, treemap } from "@hatbot/shared";
import { CHAR_W, color, cutTo, Plot, TipRow, usePlot } from "./frame";

const HEIGHT = 240;
const PAD = 6;

export function TreemapPlot({ spec }: { spec: TreemapChart }) {
  // Largest first, so the arrow keys go from the biggest box down.
  const items = [...spec.items].sort((a, b) => b.value - a.value);
  const p = usePlot(items.length, "ArrowLeft", "ArrowRight");
  const { width, at } = p;
  const fmt = (v: number) => chartValue(v, spec.unit);
  const tiles = treemap(
    items.map((it) => it.value),
    width,
    HEIGHT,
  );
  const max = Math.max(...items.map((it) => it.value));
  const total = items.reduce((n, it) => n + it.value, 0);

  return (
    <Plot
      title={spec.title}
      p={p}
      height={HEIGHT}
      pick={(px, py) => {
        const t = tiles.find((t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h);
        return t ? t.i : null;
      }}
      tip={(k) => {
        const t = tiles.find((t) => t.i === k);
        if (!t) return {};
        const below = t.y + t.h + 4 < HEIGHT - 40;
        return below
          ? { left: Math.min(t.x, width - 160), top: t.y + t.h + 4 }
          : { left: Math.min(t.x, width - 160), top: "auto", bottom: HEIGHT - t.y + 4 };
      }}
      readout={(k) => {
        const it = items[k] as TreemapChart["items"][number];
        return (
          <>
            <div className="chart-tip-x">{it.label}</div>
            <TipRow value={fmt(it.value)} name={`${Math.round((it.value / total) * 100)}%`} />
          </>
        );
      }}
      table={{ head: ["", "Value"], rows: items.map((it) => [it.label, fmt(it.value)]) }}
    >
      {tiles.map((t) => {
        const it = items[t.i] as TreemapChart["items"][number];
        const roomy = t.w >= 56 && t.h >= 30;
        const cut = Math.floor((t.w - 2 * PAD) / CHAR_W);
        return (
          <g key={t.i}>
            <rect
              x={t.x + 1}
              y={t.y + 1}
              width={Math.max(0, t.w - 2)}
              height={Math.max(0, t.h - 2)}
              rx={4}
              fill={color(0)}
              fillOpacity={0.1 + 0.4 * (it.value / max)}
              className={at === t.i ? "tile on" : "tile"}
            />
            {roomy && (
              <>
                <text x={t.x + PAD} y={t.y + PAD + 8} className="tile-label">
                  {cutTo(it.label, cut)}
                </text>
                {t.h >= 44 && (
                  <text x={t.x + PAD} y={t.y + PAD + 23} className="tick">
                    {cutTo(fmt(it.value), cut)}
                  </text>
                )}
              </>
            )}
          </g>
        );
      })}
    </Plot>
  );
}
