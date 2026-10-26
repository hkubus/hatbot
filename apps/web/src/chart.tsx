import type { ChartData, ChartFile, ChartSpec } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { ListingsRow } from "./charts/listings";
import { MatrixPlot } from "./charts/matrix";
import { RangePlot } from "./charts/range";
import { ScatterPlot } from "./charts/scatter";
import { HEIGHT, SeriesPlot } from "./charts/series";
import { TimelinePlot } from "./charts/timeline";
import { withData } from "./chartspec";

export { useWidth } from "./charts/frame";

export function ChartPending() {
  return <div className="reply-chart pending" style={{ height: HEIGHT }} />;
}

export function Chart({ spec }: { spec: ChartSpec }) {
  switch (spec.type) {
    case "scatter":
      return <ScatterPlot spec={spec} />;
    case "range":
      return <RangePlot spec={spec} />;
    case "matrix":
      return <MatrixPlot spec={spec} />;
    case "timeline":
      return <TimelinePlot spec={spec} />;
    case "listings":
      return <ListingsRow spec={spec} />;
    default:
      return <SeriesPlot spec={spec} />;
  }
}

/** Cached for good: a file never changes. */
const fetched = new Map<string, Promise<ChartData>>();

function values(id: number, type: ChartFile["type"]): Promise<ChartData> {
  const path = `/attachments/${id}/chart?type=${type}`;
  let p = fetched.get(path);
  if (!p) {
    p = api<ChartData>(path);
    fetched.set(path, p);
    p.catch(() => fetched.delete(path));
  }
  return p;
}

export function FileChart({ file }: { file: ChartFile }) {
  const [shown, setShown] = useState<{ spec: ChartSpec | null; error?: string } | null>(null);
  const source = JSON.stringify(file);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is `file`, compared by value.
  useEffect(() => {
    let live = true;
    values(file.data, file.type).then(
      (v) => live && setShown({ spec: withData(file, v) }),
      (err) =>
        live && setShown({ spec: null, error: errorText(err, "The chart's data didn't load.") }),
    );
    return () => {
      live = false;
    };
  }, [source]);
  if (!shown) return <ChartPending />;
  if (!shown.spec) return <p className="muted">{shown.error ?? "The chart's data didn't load."}</p>;
  return <Chart spec={shown.spec} />;
}
