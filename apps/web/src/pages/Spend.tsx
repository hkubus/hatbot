import type { SpendByModel, SpendDay, SpendSummary } from "@hatbot/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

const money = (v: number) => `$${v.toFixed(2)}`;
const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku 4.5",
};
const parseDay = (d: string) => new Date(`${d}T12:00:00`);
const fmtDay = (d: string) =>
  parseDay(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const fmtShort = (d: string) =>
  parseDay(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** A tick step from 1/2/5 × 10^n that gives about five gridlines. */
function niceStep(max: number) {
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
}

function DailyChart({ days, limit }: { days: SpendDay[]; limit: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const W = 720;
  const H = 230;
  const L = 40;
  const R = 8;
  const T = 14;
  const B = 26;
  const step = niceStep(Math.max(limit, ...days.map((d) => d.usd)));
  const max = Math.ceil(Math.max(limit, ...days.map((d) => d.usd)) / step) * step;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const pw = W - L - R;
  const ph = H - T - B;
  const band = pw / days.length;
  const bw = Math.min(16, band - 4);
  const y = (v: number) => T + ph - (v / max) * ph;
  const peak = days.reduce((a, d, i) => (d.usd > (days[a]?.usd ?? 0) ? i : a), 0);
  // Only the peak gets a label: today's figure is in the tile above, and a label on a short bar collides with its neighbours.
  const labelled = (days[peak]?.usd ?? 0) > 0 ? [peak] : [];
  const xLabels = days.map((_, i) => i).filter((i) => i % 7 === 0);

  const onMove = (e: React.MouseEvent<SVGRectElement>, i: number) => {
    const b = box.current?.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (b)
      setHover({ i, x: r.left - b.left + r.width / 2, y: (y(days[i]?.usd ?? 0) / H) * b.height });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only shows a tooltip; the Table view has the same numbers
    <div className="chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily spend, last 30 days">
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end">
              ${t % 1 ? t.toFixed(1) : t}
            </text>
          </g>
        ))}
        <line className="refline" x1={L} x2={W - R} y1={y(limit)} y2={y(limit)} />
        <text x={W - R} y={y(limit) - 5} textAnchor="end" style={{ fill: "var(--text-2)" }}>
          Daily limit {money(limit)}
        </text>
        {days.map((d, i) => {
          const x = L + i * band + (band - bw) / 2;
          const top = y(d.usd);
          const h = T + ph - top;
          const r = Math.min(4, h);
          const path = `M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ph} Z`;
          return (
            <g key={d.date}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: hover target for the tooltip */}
              <rect
                className="hit"
                x={L + i * band}
                y={T}
                width={band}
                height={ph}
                onMouseMove={(e) => onMove(e, i)}
              />
              {h > 0 && <path className={`bar ${hover?.i === i ? "hl" : ""}`} d={path} />}
            </g>
          );
        })}
        {labelled.map((i) => (
          <text
            key={i}
            x={L + i * band + band / 2}
            y={y(days[i]?.usd ?? 0) - 6}
            textAnchor="middle"
            style={{ fill: "var(--text-2)", fontWeight: 600 }}
          >
            {money(days[i]?.usd ?? 0)}
          </text>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={L + i * band + band / 2} y={H - 6} textAnchor="middle">
            {fmtShort(days[i]?.date ?? "")}
          </text>
        ))}
      </svg>
      {hover && days[hover.i] && (
        <div className="tooltip show" style={{ left: hover.x, top: hover.y }}>
          <b>{fmtDay(days[hover.i]?.date ?? "")}</b>
          {money(days[hover.i]?.usd ?? 0)}
        </div>
      )}
    </div>
  );
}

export function Spend() {
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [days, setDays] = useState<SpendDay[]>([]);
  const [models, setModels] = useState<SpendByModel[]>([]);
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const live = useStore((s) => s.todayUsd);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when a new request is billed
  useEffect(() => {
    api<SpendSummary>("/spend/summary").then(setSummary);
    api<SpendDay[]>("/spend/daily?days=30").then(setDays);
    api<SpendByModel[]>("/spend/by-model?days=30").then(setModels);
  }, [live]);

  if (!summary) return <section className="view" />;
  const { todayUsd, monthUsd, limits } = summary;
  const mMax = Math.max(0.0001, ...models.map((m) => m.usd));

  return (
    <section className="view">
      <div className="page">
        <div className="kpis">
          <div className="tile">
            <div className="label">Today</div>
            <div className="value tnum">
              {money(todayUsd)} <small>of {money(limits.dailyUsd)}</small>
            </div>
            <div className={`meter ${todayUsd >= limits.dailyUsd ? "hot" : ""}`}>
              <span style={{ width: `${Math.min(100, (todayUsd / limits.dailyUsd) * 100)}%` }} />
            </div>
          </div>
          <div className="tile">
            <div className="label">This month</div>
            <div className="value tnum">
              {money(monthUsd)} <small>of {money(limits.monthlyUsd)}</small>
            </div>
            <div className={`meter ${monthUsd >= limits.monthlyUsd ? "hot" : ""}`}>
              <span style={{ width: `${Math.min(100, (monthUsd / limits.monthlyUsd) * 100)}%` }} />
            </div>
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-head">
            <h3>Last 30 days</h3>
            <span className="spacer" />
            <div className="seg">
              <button
                type="button"
                className={mode === "chart" ? "active" : ""}
                onClick={() => setMode("chart")}
              >
                Chart
              </button>
              <button
                type="button"
                className={mode === "table" ? "active" : ""}
                onClick={() => setMode("table")}
              >
                Table
              </button>
            </div>
          </div>
          {mode === "chart" ? (
            days.length > 0 && <DailyChart days={days} limit={limits.dailyUsd} />
          ) : (
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {[...days].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{fmtDay(d.date)}</td>
                      <td className="num">{money(d.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="chart-card">
          <div className="chart-head">
            <h3>By model, last 30 days</h3>
          </div>
          {models.length ? (
            <div className="hbars">
              {models.map((m) => (
                <div className="hbar" key={m.model}>
                  <span>{MODEL_NAMES[m.model] ?? m.model}</span>
                  <div className="track">
                    <div className="fill" style={{ width: `${(m.usd / mMax) * 100}%` }} />
                  </div>
                  <span className="v">{money(m.usd)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">Nothing spent yet.</div>
          )}
        </div>
      </div>
    </section>
  );
}
