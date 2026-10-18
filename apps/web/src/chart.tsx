// A ```chart block in a reply, drawn as SVG (a table for a matrix) in Hatbot's colours, each kind
// in charts/ with a readout that follows the pointer and the arrow keys.
import type { ChartSpec } from "@hatbot/shared";
import { MatrixPlot } from "./charts/matrix";
import { RangePlot } from "./charts/range";
import { ScatterPlot } from "./charts/scatter";
import { HEIGHT, SeriesPlot } from "./charts/series";
import { TimelinePlot } from "./charts/timeline";

export { useWidth } from "./charts/frame";

/** Same footprint as the chart, while its block is still streaming in. */
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
    default:
      return <SeriesPlot spec={spec} />;
  }
}
