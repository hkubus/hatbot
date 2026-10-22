import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export const CHAR_W = 6.2;

export const color = (i: number) => `var(--series-${i + 1})`;

export const cutTo = (l: string, cut: number) =>
  l.length > cut ? `${l.slice(0, Math.max(1, cut - 1))}…` : l;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function useWidth(ref: React.RefObject<HTMLElement | null>): number {
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

export function usePlot(n: number, back: string, fwd: string) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [at, setAt] = useState<number | null>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    const step = e.key === back ? -1 : 1;
    setAt((i) => clamp(i === null ? (step > 0 ? 0 : n - 1) : i + step, 0, n - 1));
  };
  const dim = (i: number) => (at === null || at === i ? 1 : 0.45);
  return { ref, width, at, setAt, onKey, dim };
}
export type PlotState = ReturnType<typeof usePlot>;

export type LegendItem = {
  name: string;
  shape: "key" | "swatch" | "point";
  color: string;
};

export type ChartTable = { head: string[]; rows: string[][] };

export function Plot({
  title,
  legend,
  p: { ref, width, at, setAt, onKey },
  height,
  pick,
  tip,
  readout,
  table,
  children,
}: {
  title?: string;
  legend?: LegendItem[];
  p: PlotState;
  height: number;
  pick: (x: number, y: number) => number | null;
  tip: (i: number) => React.CSSProperties;
  readout: (i: number) => ReactNode;
  table: ChartTable;
  children: ReactNode;
}) {
  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(pick(e.clientX - box.left, e.clientY - box.top));
  };
  return (
    <figure className="reply-chart">
      {title && <figcaption className="chart-title">{title}</figcaption>}
      {legend && legend.length > 0 && <Legend items={legend} />}
      <div className="chart-plot" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={title ?? "Chart"}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move the readout; the hidden table carries the values for screen readers
            tabIndex={0}
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={(e) => e.pointerType === "mouse" && setAt(null)}
            onKeyDown={onKey}
            onBlur={() => setAt(null)}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </svg>
        )}
        {at !== null && (
          <div className="chart-tip" style={tip(at)}>
            {readout(at)}
          </div>
        )}
      </div>
      <ChartTableView table={table} />
    </figure>
  );
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="chart-legend">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: series are positional, and two can share a name
        <span key={i}>
          <i className={it.shape} style={{ background: it.color }} />
          {it.name}
        </span>
      ))}
    </div>
  );
}

function ChartTableView({ table }: { table: ChartTable }) {
  return (
    <table className="sr-only">
      <thead>
        <tr>
          {table.head.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <tr key={i}>
            {row.map((cell, j) =>
              j === 0 ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <th key={j}>{cell}</th>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <td key={j}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TipRow({
  value,
  name,
  mark,
  className,
}: {
  value: ReactNode;
  name?: ReactNode;
  mark?: string;
  className?: string;
}) {
  return (
    <div className={className ? `chart-tip-row ${className}` : "chart-tip-row"}>
      {mark && <i className="key" style={{ background: mark }} />}
      <strong>{value}</strong>
      {name && <span>{name}</span>}
    </div>
  );
}

/** Where the readout sits beside a point at x: on the side with more room. */
export const tipBeside = (x: number, width: number, top?: number): React.CSSProperties => ({
  ...(x < width / 2 ? { left: x + 12 } : { right: width - x + 12 }),
  ...(top === undefined ? {} : { top }),
});
