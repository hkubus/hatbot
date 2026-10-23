import type {
  SpendByModel,
  SpendByPurpose,
  SpendDay,
  SpendHour,
  SpendSummary,
} from "@hatbot/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useWidth } from "../chart";
import { dateOnly, day, modelName, time, tokens, usd, weekday } from "../format";
import { Link } from "../link";
import { PageLoad, useLoad } from "../load";
import { spendAxis, withToday } from "../spend";
import { useStore } from "../store";
import { Seg } from "../ui";

const PURPOSE_NAMES: Record<string, string> = {
  thread: "Chat",
  "keep-warm": "Keeping chats cached",
  task: "Tasks",
  summary: "Summaries",
  expert: "Asking Opus",
  research: "Research",
  review: "Reviewing changes",
  screening: "Checking pages",
  heartbeat: "Heartbeat",
  check: "Check everything",
  teach: "Teaching",
  tidy: "Memory tidy-ups",
  "skill-fix": "Skill fixes",
  boxes: "Boxes",
};
const purposeName = (p: string) =>
  PURPOSE_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1).replace(/-/g, " ");

type Point = { key: string; usd: number; axis?: string; title: string; detail: string };

function BarChart({ points, limit, label }: { points: Point[]; limit?: number; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  // Drawn at the width it's shown at, so the labels stay 11px on a phone and on a wide screen.
  const W = useWidth(box) || 720;
  const H = 230;
  const L = 44;
  const R = 8;
  const T = 14;
  const B = 26;
  const { max, ticks, tick, showLimit } = spendAxis(
    points.map((p) => p.usd),
    limit,
  );
  const pw = W - L - R;
  const ph = H - T - B;
  const band = pw / points.length;
  const bw = Math.min(16, band - 4);
  const y = (v: number) => T + ph - (v / max) * ph;
  const peak = points.reduce((a, p, i) => (p.usd > (points[a]?.usd ?? 0) ? i : a), 0);
  // Only the peak gets a label: the tiles above have the latest figures, and a label on a short bar collides with its neighbours.
  const labelled = (points[peak]?.usd ?? 0) > 0 ? [peak] : [];

  const onMove = (e: React.MouseEvent<SVGRectElement>, i: number) => {
    const b = box.current?.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (b)
      setHover({
        i,
        x: r.left - b.left + r.width / 2,
        y: (y(points[i]?.usd ?? 0) / H) * b.height,
      });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only shows a tooltip; the Table view has the same numbers
    <div className="chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end">
              {tick(t)}
            </text>
          </g>
        ))}
        {limit !== undefined && showLimit && (
          <>
            <line className="refline" x1={L} x2={W - R} y1={y(limit)} y2={y(limit)} />
            <text className="label" x={W - R} y={y(limit) - 5} textAnchor="end">
              Daily limit {usd(limit)}
            </text>
          </>
        )}
        {points.map((p, i) => {
          const x = L + i * band + (band - bw) / 2;
          const top = y(p.usd);
          const h = T + ph - top;
          const r = Math.min(4, h);
          const path = `M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ph} Z`;
          return (
            <g key={p.key}>
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
            y={y(points[i]?.usd ?? 0) - 6}
            textAnchor="middle"
            className="label peak"
          >
            {usd(points[i]?.usd ?? 0)}
          </text>
        ))}
        {points.map(
          (p, i) =>
            p.axis && (
              <text key={p.key} x={L + i * band + band / 2} y={H - 6} textAnchor="middle">
                {p.axis}
              </text>
            ),
        )}
      </svg>
      {hover && points[hover.i] && (
        <div className="chart-tip above" style={{ left: hover.x, top: hover.y }}>
          <b>{points[hover.i]?.title}</b>
          {points[hover.i]?.detail}
        </div>
      )}
    </div>
  );
}

function SpendCard({ title, points, limit }: { title: string; points: Point[]; limit?: number }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  return (
    <div className="chart-card">
      <div className="chart-head">
        <h3>{title}</h3>
        <span className="spacer" />
        <Seg
          value={mode}
          options={[
            ["chart", "Chart"],
            ["table", "Table"],
          ]}
          onChange={setMode}
        />
      </div>
      {mode === "chart" ? (
        points.length > 0 && <BarChart points={points} limit={limit} label={title} />
      ) : (
        <div className="chart-table">
          <table className="table">
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.key}>
                  <td>{p.title}</td>
                  <td className="num">{p.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** With `of`, a meter of how much of it is used. */
function Kpi({ label, usd: v, of }: { label: string; usd: number; of?: number }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value tnum">
        {usd(v)}
        {of !== undefined && (
          <>
            {" "}
            <small>of {usd(of)}</small>
          </>
        )}
      </div>
      {of !== undefined && (
        <div className={`meter ${v >= of ? "hot" : ""}`}>
          <span style={{ width: `${Math.min(100, (v / of) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function HBars({
  title,
  bars,
}: {
  title: string;
  bars: { key: string; label: string; usd: number }[];
}) {
  const max = Math.max(0.0001, ...bars.map((b) => b.usd));
  return (
    <div className="chart-card">
      <div className="chart-head">
        <h3>{title}</h3>
      </div>
      {bars.length ? (
        <div className="hbars">
          {bars.map((b) => (
            <div className="hbar" key={b.key}>
              <span>{b.label}</span>
              <div className="track">
                <div className="fill" style={{ width: `${(b.usd / max) * 100}%` }} />
              </div>
              <span className="v">{usd(b.usd)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted">Nothing spent yet.</div>
      )}
    </div>
  );
}

/** The value, changing at most every `ms`: the latest one once the time is up. */
function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const t = setTimeout(
      () => {
        last.current = Date.now();
        setOut(value);
      },
      Math.max(0, last.current + ms - Date.now()),
    );
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

export function Spend() {
  const botNames = useStore((s) => s.bots);
  const live = useStore((s) => s.todayUsd);
  const settingsVersion = useStore((s) => s.settingsVersion);
  // A desktop task bills every step: today's figures follow within 10 s, the 30-day totals within
  // 5 minutes.
  const billed = useThrottled(live, 10_000);
  const billedLately = useThrottled(live, 300_000);
  const [tick, setTick] = useState(0);

  // The last minute and hour move on even when nothing new is billed.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const now = useLoad(
    () =>
      Promise.all([
        api<SpendSummary>("/spend/summary"),
        api<SpendHour[]>("/spend/hourly?hours=24"),
        api<SpendDay[]>("/spend/daily?days=1"),
      ]),
    [billed, settingsVersion, tick],
  );
  const month = useLoad(
    () =>
      Promise.all([
        api<SpendDay[]>("/spend/daily?days=30"),
        api<SpendByModel[]>("/spend/by-model?days=30"),
        api<{ botId: string; usd: number }[]>("/spend/by-bot?days=30"),
        // A brain from before it had this answers 404; the card just stays away.
        api<SpendByPurpose[]>("/spend/by-purpose?days=30").catch(() => []),
      ]),
    [billedLately],
  );

  if (!now.data)
    return (
      <PageLoad
        wide
        error={now.error}
        retry={() => {
          now.retry();
          month.retry();
        }}
      />
    );
  const [summary, hours, today] = now.data;
  const [monthDays = [], models = [], byBot = [], byPurpose = []] = month.data ?? [];
  const days = withToday(monthDays, today);
  const { todayUsd, monthUsd, limits } = summary;
  const hourPoints: Point[] = hours.map((h, i) => ({
    key: h.hour,
    usd: h.usd,
    axis: i % 6 === 0 ? time(h.hour) : undefined,
    title: `${time(h.hour)}–${time(new Date(Date.parse(h.hour) + 3600_000).toISOString())}`,
    detail: `${usd(h.usd)} · ${tokens(h.tokens)} tokens`,
  }));
  const dayPoints: Point[] = days.map((d, i) => ({
    key: d.date,
    usd: d.usd,
    axis: i % 7 === 0 ? day(dateOnly(d.date)) : undefined,
    title: weekday(dateOnly(d.date)),
    detail: usd(d.usd),
  }));

  return (
    <section className="view">
      <div className="page">
        <div className="page-head">
          <span className="spacer" />
          <Link className="btn" to="/settings#spending">
            Limits
          </Link>
        </div>
        <div className="kpis">
          <Kpi label="Today" usd={todayUsd} of={limits.dailyUsd} />
          <Kpi label="This month" usd={monthUsd} of={limits.monthlyUsd} />
          <Kpi label="Last hour" usd={summary.lastHour.usd} />
          <Kpi label="Last minute" usd={summary.lastMinute.usd} />
        </div>

        <SpendCard title="Last 24 hours" points={hourPoints} />
        <SpendCard title="Last 30 days" points={dayPoints} limit={limits.dailyUsd} />

        <HBars
          title="By model, last 30 days"
          bars={models.map((m) => ({ key: m.model, label: modelName(m.model), usd: m.usd }))}
        />
        {byBot.length > 1 && (
          <HBars
            title="By bot, last 30 days"
            bars={byBot.map((b) => ({
              key: b.botId,
              label: botNames[b.botId]?.name ?? b.botId,
              usd: b.usd,
            }))}
          />
        )}
        {byPurpose.length > 0 && (
          <HBars
            title="By purpose, last 30 days"
            bars={byPurpose.map((p) => ({
              key: p.purpose,
              label: purposeName(p.purpose),
              usd: p.costUsd,
            }))}
          />
        )}
      </div>
    </section>
  );
}
