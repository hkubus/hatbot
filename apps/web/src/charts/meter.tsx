import { chartValue, type MeterChart } from "@hatbot/shared";

export function MeterPlot({ spec }: { spec: MeterChart }) {
  const fmt = (v: number) => chartValue(v, spec.unit);
  return (
    <figure className="reply-chart">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      <div className="chart-meters">
        {spec.rows.map((r, i) => {
          const over = r.value > r.max || (r.warn !== undefined && r.value >= r.warn);
          const text = `${fmt(r.value)} / ${fmt(r.max)}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <div key={i} className="chart-meter">
              <span className="meter-label">{r.label}</span>
              <span className="meter-value">{text}</span>
              <div className="meter-track" aria-hidden="true">
                <i
                  className={over ? "over" : undefined}
                  style={{ width: `${Math.min(100, (r.value / r.max) * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
