import { type CalendarChart, calendarWeeks, chartValue } from "@hatbot/shared";
import { clamp, color, Plot, TipRow, tipBeside, usePlot } from "./frame";
import { dateText } from "./timeline";

const TOP = 16;
const LEFT = 30;
const GAP = 2;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function CalendarPlot({ spec }: { spec: CalendarChart }) {
  const days = [...spec.days].sort((a, b) => a.date.localeCompare(b.date));
  const n = days.length;
  const p = usePlot(n, "ArrowLeft", "ArrowRight");
  const { width, at } = p;
  const fmt = (v: number) => chartValue(v, spec.unit);
  const weeks = calendarWeeks(days.map((d) => d.date));
  const value = new Map(days.map((d, i) => [d.date, i]));

  const cell = clamp(Math.floor((width - LEFT) / weeks.length) - GAP, 6, 14);
  const pitch = cell + GAP;
  const height = TOP + 7 * pitch;
  const vs = days.map((d) => d.value);
  // From zero, so a day with nothing (no failed backups) reads as empty.
  const lo = Math.min(0, ...vs);
  const hi = Math.max(...vs);
  const strength = (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 1);
  const spot = (i: number) => {
    const t = Date.parse(`${(days[i] as { date: string }).date}T00:00:00Z`);
    const w = Math.floor((t - (weeks[0]?.[0] ?? t)) / (7 * 86_400_000));
    const d = (new Date(t).getUTCDay() + 6) % 7;
    return { x: LEFT + w * pitch, y: TOP + d * pitch };
  };

  return (
    <Plot
      title={spec.title}
      p={p}
      height={height}
      pick={(px, py) => {
        const week = weeks[Math.floor((px - LEFT) / pitch)];
        const day = week?.[Math.floor((py - TOP) / pitch)];
        return day === undefined ? null : (value.get(iso(day)) ?? null);
      }}
      tip={(i) => {
        const s = spot(i);
        return tipBeside(s.x + cell / 2, width, s.y < height / 2 ? s.y + pitch : undefined);
      }}
      readout={(i) => {
        const d = days[i] as CalendarChart["days"][number];
        return (
          <>
            <div className="chart-tip-x">{dateText(d.date)}</div>
            <TipRow value={fmt(d.value)} />
          </>
        );
      }}
      table={{ head: ["", "Value"], rows: days.map((d) => [dateText(d.date), fmt(d.value)]) }}
    >
      {DAYS.map((name, d) =>
        name ? (
          <text key={name} x={0} y={TOP + d * pitch + cell / 2} className="tick row">
            {name}
          </text>
        ) : null,
      )}
      {weeks.map((week, w) => {
        // A month's name over the week it starts in, if the last one's name has room.
        const first = week.find((t) => new Date(t).getUTCDate() === 1);
        const label = w === 0 ? (first ?? week[6]) : w > 1 ? first : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: weeks are positional
          <g key={w}>
            {label !== undefined && (
              <text x={LEFT + w * pitch} y={TOP - 6} className="tick">
                {MONTHS[new Date(label).getUTCMonth()]}
              </text>
            )}
            {week.map((t, d) => {
              const i = value.get(iso(t));
              const v = i === undefined ? null : (days[i] as { value: number }).value;
              const empty = v === null || !strength(v);
              return (
                <rect
                  key={t}
                  x={LEFT + w * pitch}
                  y={TOP + d * pitch}
                  width={cell}
                  height={cell}
                  rx={2}
                  className={`day${empty ? " none" : ""}${at === i ? " on" : ""}`}
                  fill={empty ? undefined : color(0)}
                  fillOpacity={empty ? undefined : 0.2 + 0.8 * strength(v)}
                />
              );
            })}
          </g>
        );
      })}
    </Plot>
  );
}
