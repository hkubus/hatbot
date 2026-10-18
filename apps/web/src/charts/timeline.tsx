// Dated events along one time axis: a dot for a date, a bar for a span, each named beside itself.
// Lanes are rows under their own name; inside a lane, events whose names would collide take the
// next track down.
import { dateRange, type TimelineChart } from "@hatbot/shared";
import { CHAR_W, clamp, color, cutTo, Plot, TipRow, tipBeside, usePlot } from "./frame";

const DAY = 86_400_000;
const TRACK = 22;
const LANE_H = 20;
const AXIS_H = 22;
const THICK = 8;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2024 · Mar 2024 · Mar 15, 2024. */
function dateText(d: string) {
  const [y, m, day] = d.split("-");
  if (!m) return y as string;
  const month = MONTHS[Number(m) - 1];
  return day ? `${month} ${Number(day)}, ${y}` : `${month} ${y}`;
}

const when = (e: { date: string; end?: string }) =>
  e.end ? `${dateText(e.date)} – ${dateText(e.end)}` : dateText(e.date);

/**
 * Ticks inside [lo, hi] (UTC ms), no closer than `gap` px on a `width` px axis: years, months or
 * days, whichever the span needs.
 */
function timeTicks(lo: number, hi: number, width: number, gap: number) {
  const fit = Math.max(2, Math.floor(width / gap));
  const days = (hi - lo) / DAY;
  const d0 = new Date(lo);
  const [y0, m0] = [d0.getUTCFullYear(), d0.getUTCMonth()];
  const ticks: { t: number; text: string }[] = [];
  if (days > 3 * 366) {
    const years = (hi - lo) / (365.25 * DAY);
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => years / s <= fit) ?? 1000;
    const from = Math.floor(y0 / step) * step;
    for (let y = from; ; y += step) {
      const t = Date.UTC(y, 0, 1);
      ticks.push({ t, text: String(y) });
      if (t >= hi) break;
    }
  } else if (days > 62) {
    const months = days / 30.4;
    const step = [1, 2, 3, 6, 12].find((s) => months / s <= fit) ?? 12;
    const from = Math.floor((y0 * 12 + m0) / step) * step;
    for (let k = from; ; k += step) {
      const t = Date.UTC(Math.floor(k / 12), k % 12, 1);
      ticks.push({ t, text: k % 12 === 0 ? String(k / 12) : (MONTHS[k % 12] as string) });
      if (t >= hi) break;
    }
  } else {
    const step = [1, 2, 7, 14].find((s) => days / s <= fit) ?? 28;
    const start = Date.UTC(y0, m0, d0.getUTCDate());
    for (let t = start; ; t += step * DAY) {
      const d = new Date(t);
      ticks.push({ t, text: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` });
      if (t >= hi) break;
    }
  }
  const inside = ticks.filter((tk) => tk.t >= lo && tk.t <= hi);
  // Without a January on a month axis, the first tick says the year.
  const first = inside[0];
  if (first && days > 62 && !inside.some((tk) => /^\d/.test(tk.text)))
    first.text = `${first.text} ${new Date(first.t).getUTCFullYear()}`;
  return inside;
}

export function TimelinePlot({ spec }: { spec: TimelineChart }) {
  // Each event's days, first to last inclusive, in time order; the arrow keys go in this order.
  const events = spec.events
    .map((e) => {
      const t0 = dateRange(e.date)[0];
      const t1 = dateRange(e.end ?? e.date)[1] + DAY;
      return { ...e, t0, t1, span: e.end !== undefined };
    })
    .sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  const n = events.length;
  const p = usePlot(n, "ArrowLeft", "ArrowRight");
  const { width, dim } = p;

  const laneNames = [...new Set(spec.events.map((e) => e.lane ?? ""))];
  const named = laneNames.length > 1 || laneNames[0] !== "";

  const pad = 5;
  const plotW = Math.max(40, width - 2 * pad);
  const lo = Math.min(...events.map((e) => e.t0));
  const hi = Math.max(...events.map((e) => e.t1));
  const ticks = timeTicks(lo, hi, plotW, 64);
  const x = (t: number) => pad + ((t - lo) / (hi - lo)) * plotW;

  // Where each event's mark and name go, and which track of its lane it takes.
  const placed = events.map((e) => {
    const [x0, x1] = e.span
      ? [x(e.t0), Math.max(x(e.t1), x(e.t0) + THICK)]
      : [x((e.t0 + e.t1) / 2) - 4, x((e.t0 + e.t1) / 2) + 4];
    const full = e.label.length * CHAR_W;
    const roomRight = width - x1 - 6;
    const roomLeft = x0 - 6;
    // Beside the mark, right first; where neither side has room, on the track below it.
    const side = roomRight >= full ? "right" : roomLeft >= full ? "left" : "under";
    const text = cutTo(e.label, Math.floor(width / CHAR_W));
    const w = text.length * CHAR_W;
    const lx = side === "right" ? x1 + 6 : side === "left" ? x0 - 6 : clamp(x0, 0, width - w);
    const box: [number, number] =
      side === "right"
        ? [x0, lx + w]
        : side === "left"
          ? [lx - w, x1]
          : [Math.min(x0, lx), Math.max(x1, lx + w)];
    return { ...e, x0, x1, text, side, lx, box, track: 0 };
  });
  const lanes = laneNames.map((name) => {
    // How far right each track is taken.
    const ends: number[] = [];
    const free = (k: number, from: number) => (ends[k] ?? Number.NEGATIVE_INFINITY) + 8 <= from;
    for (const e of placed) {
      if ((e.lane ?? "") !== name) continue;
      const under = e.side === "under";
      let k = 0;
      while (!free(k, e.box[0]) || (under && !free(k + 1, e.box[0]))) k++;
      ends[k] = e.box[1];
      if (under) ends[k + 1] = e.box[1];
      e.track = k;
    }
    return { name, tracks: ends.length };
  });
  let y = 4;
  const laneTop = lanes.map((l) => {
    const top = y;
    y += (named ? LANE_H : 0) + l.tracks * TRACK;
    return top;
  });
  const plotH = y + 4;
  const height = plotH + AXIS_H;
  const rowY = (e: (typeof placed)[number]) =>
    (laneTop[laneNames.indexOf(e.lane ?? "")] as number) +
    (named ? LANE_H : 0) +
    e.track * TRACK +
    TRACK / 2;

  const pick = (px: number, py: number) => {
    let best: number | null = null;
    let bestD = 24;
    placed.forEach((e, i) => {
      const dy = py - rowY(e);
      if (dy < -TRACK / 2 || dy > (e.side === "under" ? 1.5 : 0.5) * TRACK) return;
      const d = px < e.box[0] ? e.box[0] - px : px > e.box[1] ? px - e.box[1] : 0;
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  };

  return (
    <Plot
      title={spec.title}
      p={p}
      height={height}
      pick={pick}
      tip={(i) => {
        const e = placed[i] as (typeof placed)[number];
        const cy = rowY(e);
        const at = e.span ? e.x0 : (e.x0 + e.x1) / 2;
        return cy < plotH / 2
          ? tipBeside(at, width, cy + TRACK / 2)
          : { ...tipBeside(at, width), top: "auto", bottom: height - cy + TRACK / 2 };
      }}
      readout={(i) => {
        const e = placed[i] as (typeof placed)[number];
        return (
          <>
            <div className="chart-tip-x">{when(e)}</div>
            <TipRow value={e.label} name={named && e.lane ? e.lane : undefined} />
          </>
        );
      }}
      table={{
        head: ["", "Date", ...(named ? ["Lane"] : [])],
        rows: placed.map((e) => [e.label, when(e), ...(named ? [e.lane ?? ""] : [])]),
      }}
    >
      {ticks.map((tk, i) => {
        const tx = x(tk.t);
        const w = tk.text.length * CHAR_W;
        const anchor = tx - w / 2 < 0 ? "start" : tx + w / 2 > width ? "end" : "middle";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional
          <g key={i}>
            <line x1={tx} x2={tx} y1={0} y2={plotH} className="grid" />
            <text x={tx} y={height - 6} className="tick x" textAnchor={anchor}>
              {tk.text}
            </text>
          </g>
        );
      })}
      {named &&
        lanes.map((l, li) => (
          <g key={l.name}>
            {li > 0 && (
              <line
                x1={0}
                x2={width}
                y1={(laneTop[li] as number) - 2}
                y2={(laneTop[li] as number) - 2}
                className="baseline"
              />
            )}
            <text x={0} y={(laneTop[li] as number) + LANE_H / 2} className="tick lane">
              {l.name || "Other"}
            </text>
          </g>
        ))}
      {placed.map((e, i) => {
        const cy = rowY(e);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: events are positional
          <g key={i} opacity={dim(i)}>
            {e.span ? (
              <rect
                x={e.x0}
                y={cy - THICK / 2}
                width={e.x1 - e.x0}
                height={THICK}
                rx={THICK / 2}
                fill={color(0)}
              />
            ) : (
              <circle cx={(e.x0 + e.x1) / 2} cy={cy} r={4} fill={color(0)} className="dot" />
            )}
            <text
              x={e.lx}
              y={e.side === "under" ? cy + TRACK : cy}
              className="end"
              textAnchor={e.side === "left" ? "end" : "start"}
            >
              {e.text}
            </text>
          </g>
        );
      })}
    </Plot>
  );
}
