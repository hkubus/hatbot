import { chartValue, type MatrixChart } from "@hatbot/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { clamp, TipRow } from "./frame";

/** The shade's strength, in % of the chart colour, from worst to best; text stays readable on both. */
const FAINT = 8;
const STRONG = 65;

/** A value without its unit, which the column's header carries: 1,200 under "Price $". */
function bare(v: number, unit?: string) {
  const s = chartValue(v, unit);
  if (!unit) return s;
  return s.endsWith(` ${unit}`) ? s.slice(0, -unit.length - 1) : s.replace(unit, "");
}

export function MatrixPlot({ spec }: { spec: MatrixChart }) {
  const { rows, columns, values } = spec;
  const [at, setAt] = useState<[number, number] | null>(null);
  const [tip, setTip] = useState<React.CSSProperties>({});
  const box = useRef<HTMLDivElement>(null);
  // Only the arrow keys scroll a cell into view; the pointer is already on one.
  const keyed = useRef(false);

  // Each cell's place between its column's worst (0) and best (1); null where a column has
  // nothing to compare.
  const ends = columns.map((_, ci) => {
    const vs = values.map((r) => r[ci]).filter((v): v is number => v != null);
    return [Math.min(...vs), Math.max(...vs)] as const;
  });
  const place = (ri: number, ci: number) => {
    const v = values[ri]?.[ci];
    const [min, max] = ends[ci] as readonly [number, number];
    if (v == null || !(max > min)) return null;
    const t = (v - min) / (max - min);
    return columns[ci]?.better === "low" ? 1 - t : t;
  };
  const shade = (t: number | null) =>
    t === null
      ? undefined
      : `color-mix(in srgb, var(--chart) ${FAINT + (STRONG - FAINT) * t}%, transparent)`;

  useLayoutEffect(() => {
    const el = box.current;
    const cell = at && el?.querySelector<HTMLElement>(`[data-cell="${at[0]}-${at[1]}"]`);
    if (!el || !cell) return;
    if (keyed.current) cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    const b = el.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    const left = clamp(c.left - b.left, 0, Math.max(0, b.width - 160));
    setTip(
      c.top - b.top < b.height / 2
        ? { left, top: c.bottom - b.top + 4 }
        : { left, top: "auto", bottom: b.bottom - c.top + 4 },
    );
  }, [at]);

  const onKey = (e: React.KeyboardEvent) => {
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[
      e.key
    ];
    if (!move) return;
    e.preventDefault();
    keyed.current = true;
    setAt((a) => [
      clamp((a?.[0] ?? 0) + (a ? (move[0] as number) : 0), 0, rows.length - 1),
      clamp((a?.[1] ?? 0) + (a ? (move[1] as number) : 0), 0, columns.length - 1),
    ]);
  };

  const point = (ri: number, ci: number) => {
    keyed.current = false;
    setAt([ri, ci]);
  };

  const rank = (ri: number, ci: number) => {
    const t = place(ri, ci);
    return t === 1 ? "best" : t === 0 ? "worst" : undefined;
  };
  const hot = at && {
    row: rows[at[0]],
    col: columns[at[1]],
    v: values[at[0]]?.[at[1]] ?? null,
    rank: rank(at[0], at[1]),
  };

  return (
    <figure className="reply-chart">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      <div className="chart-plot" ref={box}>
        <div className="chart-matrix">
          <table
            // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move the readout across the cells
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setAt(null)}
            onPointerLeave={(e) => e.pointerType === "mouse" && setAt(null)}
            onClick={(e) => e.stopPropagation()}
          >
            <thead>
              <tr>
                <td />
                {columns.map((c, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                  <th key={ci} scope="col">
                    {c.name}
                    {c.unit && <span className="unit"> {c.unit}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                <tr key={ri}>
                  <th scope="row">{r}</th>
                  {columns.map((c, ci) => {
                    const v = values[ri]?.[ci] ?? null;
                    const on = at?.[0] === ri && at[1] === ci;
                    return (
                      <td
                        // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                        key={ci}
                        data-cell={`${ri}-${ci}`}
                        className={v === null ? "none" : on ? "on" : undefined}
                        style={{ background: shade(place(ri, ci)) }}
                        onPointerEnter={() => point(ri, ci)}
                        onPointerDown={() => point(ri, ci)}
                      >
                        {v === null ? "–" : bare(v, c.unit)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hot?.row !== undefined && hot.col && (
          <div className="chart-tip" style={tip}>
            <div className="chart-tip-x">
              {hot.row} · {hot.col.name}
            </div>
            <TipRow
              value={hot.v === null ? "–" : chartValue(hot.v, hot.col.unit)}
              name={hot.rank}
            />
          </div>
        )}
      </div>
    </figure>
  );
}
