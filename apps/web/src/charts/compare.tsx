import type { CompareChart } from "@hatbot/shared";

export function ComparePlot({ spec }: { spec: CompareChart }) {
  return (
    <figure className="reply-chart">
      {spec.title && <figcaption className="chart-title">{spec.title}</figcaption>}
      <div className="chart-matrix chart-compare">
        <table>
          <thead>
            <tr>
              <td />
              {spec.columns.map((c, ci) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <th key={ci} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((r, ri) => {
              // A row that's the same for each says nothing about which to pick.
              const known = r.values.filter((v): v is string => v !== null);
              const same = known.length > 1 && known.every((v) => v === known[0]);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                <tr key={ri} className={same ? "same" : undefined}>
                  <th scope="row">{r.label}</th>
                  {r.values.map((v, ci) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                      key={ci}
                      className={v === null ? "none" : r.best === ci ? "best" : undefined}
                    >
                      {v ?? "–"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
