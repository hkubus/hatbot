// A ```chart block in a reply, drawn with Swift Charts in Hatbot's colours (the web's chart.tsx):
// lines, columns (grouped or stacked), horizontal bars, scatter plots, ranges and timelines, and a
// matrix as a grid of shaded cells. Touch and drag for the values at a point.
import Charts
import SwiftUI

struct ChartView: View {
  let spec: ChartSpec
  @State private var selectedPoint: Int?
  @State private var selectedBar: String?

  /// Series colours, in order; checked for colour-blind separation on the bot bubble (web: --series-N).
  static let palette = [
    Color(light: 0xC96F0A, dark: 0xD87A12),
    Color(light: 0x2A78D6, dark: 0x3987E5),
    Color(light: 0x138A60, dark: 0x199E70),
  ]

  /// Same footprint as a chart, while its block is still streaming in.
  static let height: CGFloat = 170

  private struct Point: Identifiable {
    var series: Int
    var index: Int
    /// The run of values between gaps it belongs to: each run is its own line.
    var run: Int
    var value: Double
    var id: String { "\(series)-\(index)" }
  }

  private var points: [Point] {
    var out: [Point] = []
    for (s, se) in spec.series.enumerated() {
      var run = 0
      for (i, v) in se.data.enumerated() {
        guard let v else {
          run += 1
          continue
        }
        out.append(Point(series: s, index: i, run: run, value: v))
      }
    }
    return out
  }

  /// A bar from start to end; stacked ones keep a gap from the one below and round only the stack's ends.
  private struct Segment: Identifiable {
    var series: Int
    var index: Int
    var start: Double
    var end: Double
    var outer: Bool
    /// The value (a stack's total) at its tip, on horizontal bars.
    var tip: String?
    var id: String { "\(series)-\(index)" }
  }

  /// `gap` is 2pt in value units, for the space between stacked segments.
  private func barSegments(gap: Double) -> [Segment] {
    guard spec.isStacked else {
      return points.filter { $0.value != 0 }.map {
        Segment(series: $0.series, index: $0.index, start: 0, end: $0.value, outer: true, tip: spec.format($0.value))
      }
    }
    let totals = spec.stackTotals
    var out: [Segment] = []
    for (i, stack) in spec.stackSpans.enumerated() {
      // The total goes at the end of the side it falls on.
      let total = totals[i]
      let tipAt = stack.indices.last { stack[$0].map { ($0.end > 0) == ((total ?? 0) >= 0) } ?? false }
      for (s, span) in stack.enumerated() {
        guard let span else { continue }
        let up = span.end > 0
        let start = span.start == 0 ? 0 : span.start + (up ? gap : -gap)
        guard up ? span.end > start : span.end < start else { continue }
        let outer = !stack[(s + 1)...].contains { $0.map { ($0.end > 0) == up } ?? false }
        out.append(Segment(
          series: s, index: i, start: start, end: span.end, outer: outer,
          tip: s == tipAt ? total.map { spec.format($0) } : nil))
      }
    }
    return out
  }

  /// The values the bars span, for the gap's size.
  private var barRange: Double {
    let ends = spec.isStacked
      ? spec.stackSpans.flatMap { $0.compactMap { $0?.end } }
      : points.map(\.value)
    return max(ends.max() ?? 0, 0) - min(ends.min() ?? 0, 0)
  }

  private var single: Bool { spec.series.count == 1 }
  private var n: Int { spec.x.count }
  private var selected: Int? {
    let i = spec.type == .bar ? selectedBar.flatMap { Int($0) } : selectedPoint
    return i.flatMap { spec.x.indices.contains($0) ? $0 : nil }
  }

  /// Horizontal bars: one row per x, its bars side by side.
  private var rowBars: Int { spec.isStacked ? 1 : spec.series.count }
  private var rowThickness: CGFloat { rowBars == 1 ? 14 : 10 }
  private var rowHeight: CGFloat { CGFloat(rowBars) * rowThickness + CGFloat(2 * (rowBars - 1)) + 10 }

  private var horizontal: Bool { spec.type == .bar && spec.horizontal }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let title = spec.title, !title.isEmpty {
        Text(title).font(.footnote.weight(.semibold))
      }
      switch spec.type {
      case .line, .bar:
        if horizontal {
          rows().frame(height: CGFloat(n) * rowHeight + (single ? 0 : 24))
        } else {
          GeometryReader { geo in
            if spec.type == .bar { bars(width: geo.size.width) } else { lines(width: geo.size.width) }
          }
          .frame(height: single ? Self.height : Self.height + 24)
        }
      case .scatter:
        if let scatter = spec.scatter { ScatterPlot(scatter: scatter) }
      case .range:
        if let ranges = spec.ranges { RangePlot(spec: spec, ranges: ranges) }
      case .matrix:
        if let matrix = spec.matrix { MatrixGrid(matrix: matrix) }
      case .timeline:
        if let timeline = spec.timeline { TimelinePlot(timeline: timeline) }
      }
    }
  }

  // MARK: Lines

  private func lines(width: CGFloat) -> some View {
    let points = points
    // Selected, every line's value there; otherwise each line's last value.
    let dots = spec.series.indices.compactMap { s in
      selected.map { i in points.first { $0.series == s && $0.index == i } }
        ?? points.last { $0.series == s }
    }
    return Chart {
      ForEach(points) { p in
        LineMark(
          x: .value("x", p.index),
          y: .value("Value", p.value),
          series: .value("Line", "\(p.series)-\(p.run)")
        )
        .foregroundStyle(by: .value("Series", spec.names[p.series]))
        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        // VoiceOver reads the point's label, not its index.
        .accessibilityLabel(spec.x[p.index])
        .accessibilityValue(spoken(p.series, p.value))
      }
      if let i = selected {
        RuleMark(x: .value("x", i))
          .foregroundStyle(Color.secondary.opacity(0.4))
          .lineStyle(StrokeStyle(lineWidth: 1))
          .annotation(
            position: .top, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(i) }
          .accessibilityHidden(true)
      }
      ForEach(dots) { p in
        PointMark(x: .value("x", p.index), y: .value("Value", p.value))
          .accessibilityHidden(true)
          .symbol { Self.dot(Self.palette[p.series]) }
          .annotation(position: .trailing, spacing: 4, overflowResolution: .init(x: .padScale, y: .disabled)) {
            // One line gets its last value beside its end.
            if single && selected == nil {
              Text(spec.format(p.value)).font(.caption2).monospacedDigit().foregroundStyle(.secondary)
            }
          }
      }
    }
    .chartXScale(domain: n == 1 ? -1...1 : 0...(n - 1))
    .chartXAxis {
      AxisMarks(values: shownLabels(width: width, every: false)) { value in
        AxisValueLabel {
          if let i = value.as(Int.self), spec.x.indices.contains(i) { Text(spec.x[i]) }
        }
      }
    }
    .chartYScale(domain: .automatic(includesZero: false))
    .chartXSelection(value: $selectedPoint)
    .modifier(Styled(spec: spec))
  }

  // MARK: Bars

  private func bars(width: CGFloat) -> some View {
    let k = spec.isStacked ? 1 : spec.series.count
    let band = max(1, (width - 44) / CGFloat(n))
    let group = min(band * 0.72, CGFloat(24 * k + 2 * (k - 1)))
    let bar = max(1, min(24, (group - CGFloat(2 * (k - 1))) / CGFloat(k)))
    let segments = barSegments(gap: 2 * barRange / Double(Self.height - 30))
    return Chart {
      ForEach(segments) { b in
        BarMark(
          x: .value("x", String(b.index)), yStart: .value("Value", b.start), yEnd: .value("Value", b.end),
          width: .fixed(bar)
        )
        .foregroundStyle(by: .value("Series", spec.names[b.series]))
        .position(by: .value("Series", spec.isStacked ? "" : spec.names[b.series]), axis: .horizontal, span: .fixed(group))
        .cornerRadius(b.outer ? 4 : 0)
        .opacity(selected == nil || selected == b.index ? 1 : 0.45)
        .accessibilityLabel(spec.x[b.index])
        .accessibilityValue(spoken(b.series, spec.series[b.series].data[b.index] ?? 0))
      }
      RuleMark(y: .value("Value", 0))
        .foregroundStyle(Color.secondary.opacity(0.5))
        .lineStyle(StrokeStyle(lineWidth: 1))
        .accessibilityHidden(true)
      if let i = selected {
        RuleMark(x: .value("x", String(i)))
          .foregroundStyle(.clear)
          .annotation(
            position: .top, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(i) }
          .accessibilityHidden(true)
      }
    }
    // Keys in x order, whichever series has the first value at each.
    .chartXScale(domain: spec.x.indices.map(String.init))
    .chartXAxis {
      AxisMarks(values: shownLabels(width: width, every: true).map(String.init)) { value in
        AxisValueLabel {
          if let key = value.as(String.self), let i = Int(key), spec.x.indices.contains(i) {
            Text(spec.x[i]).lineLimit(1)
          }
        }
      }
    }
    .chartXSelection(value: $selectedBar)
    .modifier(Styled(spec: spec))
  }

  // MARK: Rows

  private func rows() -> some View {
    let k = rowBars
    let thick = rowThickness
    let group = CGFloat(k) * thick + CGFloat(2 * (k - 1))
    // Rows are about 300pt of value axis wide on a phone; near enough for a 2pt gap.
    let segments = barSegments(gap: 2 * barRange / 300)
    return Chart {
      ForEach(segments) { b in
        BarMark(
          xStart: .value("Value", b.start), xEnd: .value("Value", b.end), y: .value("x", String(b.index)),
          height: .fixed(thick)
        )
        .foregroundStyle(by: .value("Series", spec.names[b.series]))
        .position(by: .value("Series", spec.isStacked ? "" : spec.names[b.series]), axis: .vertical, span: .fixed(group))
        .cornerRadius(b.outer ? 4 : 0)
        .opacity(selected == nil || selected == b.index ? 1 : 0.45)
        .annotation(position: b.end < 0 ? .leading : .trailing, spacing: 4, overflowResolution: .init(x: .padScale, y: .disabled)) {
          if let tip = b.tip {
            Text(tip).font(.caption2).monospacedDigit().foregroundStyle(.secondary)
          }
        }
        .accessibilityLabel(spec.x[b.index])
        .accessibilityValue(spoken(b.series, spec.series[b.series].data[b.index] ?? 0))
      }
      RuleMark(x: .value("Value", 0))
        .foregroundStyle(Color.secondary.opacity(0.5))
        .lineStyle(StrokeStyle(lineWidth: 1))
        .accessibilityHidden(true)
      if let i = selected {
        RuleMark(y: .value("x", String(i)))
          .foregroundStyle(.clear)
          .annotation(
            position: .bottom, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(i) }
          .accessibilityHidden(true)
      }
    }
    .chartYScale(domain: spec.x.indices.map(String.init))
    .chartYAxis {
      AxisMarks(position: .leading, values: spec.x.indices.map(String.init)) { value in
        AxisValueLabel {
          if let key = value.as(String.self), let i = Int(key), spec.x.indices.contains(i) {
            Text(spec.x[i]).lineLimit(1).truncationMode(.middle).frame(maxWidth: 120, alignment: .leading)
          }
        }
      }
    }
    .chartXAxis(.hidden)
    .chartYSelection(value: $selectedBar)
    .chartForegroundStyleScale(domain: spec.names, range: Array(Self.palette.prefix(spec.series.count)))
    .chartLegend(single ? .hidden : .visible)
    .chartLegend(position: .top, alignment: .leading)
  }

  // MARK: Parts

  /// Bars label every category while there's room for a word; otherwise every step-th x, as many as fit.
  private func shownLabels(width: CGFloat, every: Bool) -> [Int] {
    let plot = max(40, width - 44)
    if every && plot / CGFloat(n) >= 32 { return Array(spec.x.indices) }
    let longest = min(spec.x.map(\.count).max() ?? 1, 12)
    let fit = max(1, Int(plot / (CGFloat(longest) * 6 + 10)))
    let step = max(1, Int((Double(n) / Double(fit)).rounded(.up)))
    return spec.x.indices.filter { $0 % step == 0 }
  }

  /// What VoiceOver reads for a value: the value, then its series when there's more than one.
  private func spoken(_ series: Int, _ value: Double) -> String {
    single ? spec.format(value) : "\(spec.format(value)), \(spec.names[series])"
  }

  /// An 8pt dot with a 2pt ring of the bubble's colour, so it stays clear where lines cross.
  static func dot(_ color: Color) -> some View {
    Circle()
      .fill(color)
      .frame(width: 8, height: 8)
      .padding(2)
      .background(Circle().fill(Color.botBubble))
  }

  /// The values at one x: value first, then the series.
  private func readout(_ i: Int) -> some View {
    Readout {
      Text(spec.x[i]).foregroundStyle(.secondary)
      ForEach(spec.series.indices, id: \.self) { s in
        HStack(spacing: 5) {
          Capsule().fill(Self.palette[s]).frame(width: 10, height: 2)
          Text(spec.series[s].data[i].map { spec.format($0) } ?? "–").fontWeight(.semibold).monospacedDigit()
          if !single { Text(spec.names[s]).foregroundStyle(.secondary) }
        }
      }
      if spec.isStacked, let total = spec.stackTotals[i] {
        HStack(spacing: 5) {
          Text(spec.format(total)).fontWeight(.semibold).monospacedDigit()
          Text("total").foregroundStyle(.secondary)
        }
        .padding(.leading, 15)
      }
    }
  }

  /// What both kinds share: the colours, the legend, and the value axis.
  private struct Styled: ViewModifier {
    let spec: ChartSpec

    func body(content: Content) -> some View {
      content
        .chartForegroundStyleScale(domain: spec.names, range: Array(ChartView.palette.prefix(spec.series.count)))
        .chartLegend(spec.series.count > 1 ? .visible : .hidden)
        .chartLegend(position: .top, alignment: .leading)
        .chartYAxis {
          AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
            AxisValueLabel {
              if let v = value.as(Double.self) { Text(spec.format(v, compact: true)).monospacedDigit() }
            }
          }
        }
    }
  }
}

/// The box a touch's values show in, over the chart: value first, then what it is.
private struct Readout<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 2) { content }
      .font(.caption2)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(.background, in: .rect(cornerRadius: 8))
      .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 0.5) }
  }
}

/// A measured axis: about four round values, compact and with their unit, on hairline grid lines.
private func valueMarks(unit: String?, position: AxisMarkPosition = .automatic) -> some AxisContent {
  AxisMarks(position: position, values: .automatic(desiredCount: 4)) { value in
    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
    AxisValueLabel {
      if let v = value.as(Double.self) { Text(ChartSpec.format(v, unit: unit, compact: true)).monospacedDigit() }
    }
  }
}

// MARK: Scatter

/// Points on two measured axes. A few points are named beside them; a touch reads out the nearest.
private struct ScatterPlot: View {
  let scatter: ChartSpec.Scatter
  @State private var selectedX: Double?

  private struct Point: Identifiable {
    var series: Int
    var index: Int
    var x: Double
    var y: Double
    var label: String?
    var id: String { "\(series)-\(index)" }
  }

  /// Past a dozen points their names would pile up, so they're left to the readout.
  private static let named = 12

  private var points: [Point] {
    scatter.series.enumerated().flatMap { s, se in
      se.points.enumerated().map { i, p in Point(series: s, index: i, x: p.x, y: p.y, label: p.label) }
    }
  }

  private var single: Bool { scatter.series.count == 1 }

  /// The point nearest the touch along x, with any others at that same x.
  private func picked(_ points: [Point]) -> [Point] {
    guard let at = selectedX, let near = points.min(by: { abs($0.x - at) < abs($1.x - at) }) else { return [] }
    return points.filter { $0.x == near.x }
  }

  var body: some View {
    let points = points
    let names = scatter.names
    let picked = self.picked(points)
    let named = points.count <= Self.named
    Chart {
      ForEach(points) { p in
        PointMark(x: .value("x", p.x), y: .value("y", p.y))
          .foregroundStyle(by: .value("Series", names[p.series]))
          // Shape as well as colour, so series don't rest on colour alone.
          .symbol(by: .value("Series", names[p.series]))
          .symbolSize(50)
          .opacity(picked.isEmpty || picked.contains { $0.id == p.id } ? 0.9 : 0.35)
          .annotation(position: .top, spacing: 2) {
            if named, let label = p.label {
              Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
          }
          .accessibilityLabel(p.label ?? names[p.series])
          .accessibilityValue(spoken(p))
      }
      if let x = picked.first?.x {
        RuleMark(x: .value("x", x))
          .foregroundStyle(Color.secondary.opacity(0.4))
          .lineStyle(StrokeStyle(lineWidth: 1))
          .annotation(
            position: .top, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(picked, names: names) }
          .accessibilityHidden(true)
      }
    }
    .chartXScale(domain: .automatic(includesZero: false))
    .chartYScale(domain: .automatic(includesZero: false))
    .chartXAxis { valueMarks(unit: scatter.xUnit) }
    .chartYAxis { valueMarks(unit: scatter.yUnit, position: .leading) }
    .chartXAxisLabel(position: .bottom, alignment: .trailing) { axisName(scatter.xName) }
    .chartYAxisLabel(position: .top, alignment: .leading) { axisName(scatter.yName) }
    .chartXSelection(value: $selectedX)
    .chartForegroundStyleScale(domain: names, range: Array(ChartView.palette.prefix(names.count)))
    .chartLegend(single ? .hidden : .visible)
    .chartLegend(position: .top, alignment: .leading)
    .frame(height: single ? 210 : 234)
  }

  @ViewBuilder private func axisName(_ name: String?) -> some View {
    if let name, !name.isEmpty { Text(name).font(.caption2).foregroundStyle(.secondary) }
  }

  private func spoken(_ p: Point) -> String {
    let x = ChartSpec.format(p.x, unit: scatter.xUnit)
    let y = ChartSpec.format(p.y, unit: scatter.yUnit)
    return "\(scatter.xName ?? "x") \(x), \(scatter.yName ?? "y") \(y)"
  }

  private func readout(_ picked: [Point], names: [String]) -> some View {
    Readout {
      ForEach(Array(picked.prefix(4))) { p in
        if let name = p.label ?? (single ? nil : names[p.series]) {
          Text(name).foregroundStyle(.secondary)
        }
        HStack(spacing: 5) {
          if !single { Circle().fill(ChartView.palette[p.series]).frame(width: 6, height: 6) }
          value(p.x, unit: scatter.xUnit, name: scatter.xName)
          value(p.y, unit: scatter.yUnit, name: scatter.yName)
        }
      }
      if picked.count > 4 { Text("and \(picked.count - 4) more").foregroundStyle(.secondary) }
    }
  }

  private func value(_ v: Double, unit: String?, name: String?) -> some View {
    HStack(spacing: 3) {
      Text(ChartSpec.format(v, unit: unit)).fontWeight(.semibold).monospacedDigit()
      if let name, !name.isEmpty { Text(name).foregroundStyle(.secondary) }
    }
  }
}

// MARK: Range

/// A span from low to high for each row, its mark a dot inside; touch a row for its numbers.
private struct RangePlot: View {
  let spec: ChartSpec
  let ranges: ChartSpec.Ranges
  @State private var selectedRow: String?

  /// The span is the palette's first colour, lighter, so the mark on it stands out in the same hue.
  private static let span = ChartView.palette[0].opacity(0.45)

  private var rows: [ChartSpec.Ranges.Row] { ranges.rows }
  private var selected: Int? { selectedRow.flatMap { Int($0) }.flatMap { rows.indices.contains($0) ? $0 : nil } }
  private var markName: String { ranges.markName.flatMap { $0.isEmpty ? nil : $0 } ?? "Mark" }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if rows.contains(where: { $0.mark != nil }) {
        HStack(spacing: 12) {
          HStack(spacing: 5) {
            Capsule().fill(Self.span).frame(width: 14, height: 8)
            Text("Low to high")
          }
          HStack(spacing: 5) {
            ChartView.dot(ChartView.palette[0])
            Text(markName)
          }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
      }
      chart.frame(height: CGFloat(rows.count) * 24 + 24)
    }
  }

  private var chart: some View {
    let selected = selected
    return Chart {
      ForEach(rows.indices, id: \.self) { i in
        let row = rows[i]
        BarMark(
          xStart: .value("Value", row.low), xEnd: .value("Value", row.high), y: .value("Row", String(i)),
          height: .fixed(10)
        )
        .foregroundStyle(Self.span)
        .cornerRadius(4)
        .opacity(selected == nil || selected == i ? 1 : 0.45)
        .accessibilityLabel(row.label)
        .accessibilityValue(spoken(row))
        // A row with no width still shows, as its dot.
        if let mark = row.mark ?? (row.low == row.high ? row.low : nil) {
          PointMark(x: .value("Value", mark), y: .value("Row", String(i)))
            .symbol { ChartView.dot(ChartView.palette[0]) }
            .opacity(selected == nil || selected == i ? 1 : 0.45)
            .accessibilityHidden(true)
        }
      }
      if let i = selected {
        RuleMark(y: .value("Row", String(i)))
          .foregroundStyle(.clear)
          .annotation(
            position: .bottom, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(rows[i]) }
          .accessibilityHidden(true)
      }
    }
    .chartXScale(domain: .automatic(includesZero: false))
    .chartXAxis { valueMarks(unit: spec.unit) }
    .chartYScale(domain: rows.indices.map(String.init))
    .chartYAxis {
      AxisMarks(position: .leading, values: rows.indices.map(String.init)) { value in
        AxisValueLabel {
          if let key = value.as(String.self), let i = Int(key), rows.indices.contains(i) {
            Text(rows[i].label).lineLimit(1).truncationMode(.middle).frame(maxWidth: 120, alignment: .leading)
          }
        }
      }
    }
    .chartYSelection(value: $selectedRow)
  }

  private func spoken(_ row: ChartSpec.Ranges.Row) -> String {
    let span = "\(spec.format(row.low)) to \(spec.format(row.high))"
    return row.mark.map { "\(span), \(markName) \(spec.format($0))" } ?? span
  }

  private func readout(_ row: ChartSpec.Ranges.Row) -> some View {
    Readout {
      Text(row.label).foregroundStyle(.secondary)
      Text("\(spec.format(row.low)) – \(spec.format(row.high))").fontWeight(.semibold).monospacedDigit()
      if let mark = row.mark {
        HStack(spacing: 5) {
          Text(spec.format(mark)).fontWeight(.semibold).monospacedDigit()
          Text(markName).foregroundStyle(.secondary)
        }
      }
    }
  }
}

// MARK: Matrix

/// Options against criteria, the value in every cell. Each column is shaded in one hue from its worst
/// (light) to its best (dark); wider than the bubble, it scrolls sideways.
private struct MatrixGrid: View {
  let matrix: ChartSpec.Matrix

  /// One hue for every column, so a shade only ever means better.
  private static let hue = ChartView.palette[1]

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ScrollView(.horizontal, showsIndicators: false) {
        Grid(alignment: .trailing, horizontalSpacing: 3, verticalSpacing: 3) {
          GridRow {
            Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
            ForEach(matrix.columns.indices, id: \.self) { c in
              Text(matrix.columns[c].name)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .frame(maxWidth: 96, alignment: .trailing)
                .padding(.horizontal, 8)
            }
          }
          ForEach(matrix.rows.indices, id: \.self) { r in
            GridRow {
              Text(matrix.rows[r])
                .font(.caption)
                .lineLimit(2)
                .frame(maxWidth: 120, alignment: .leading)
                .gridColumnAlignment(.leading)
              ForEach(matrix.columns.indices, id: \.self) { c in cell(r, c) }
            }
          }
        }
      }
      if matrix.rows.count > 1 {
        Text("Darker is better in each column.").font(.caption2).foregroundStyle(.secondary)
      }
    }
  }

  private func cell(_ r: Int, _ c: Int) -> some View {
    let column = matrix.columns[c]
    let value = matrix.values[r][c].map { ChartSpec.format($0, unit: column.unit) }
    // At most half the hue under the text, so it reads in either mode.
    let shade = matrix.shade(row: r, column: c).map { 0.08 + 0.5 * $0 } ?? 0
    return Text(value ?? "–")
      .font(.caption)
      .monospacedDigit()
      .foregroundStyle(value == nil ? HierarchicalShapeStyle.secondary : .primary)
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .frame(minWidth: 52, maxWidth: .infinity, alignment: .trailing)
      .background(Self.hue.opacity(shade), in: .rect(cornerRadius: 4))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(matrix.rows[r]), \(column.name)")
      .accessibilityValue(value ?? "Not known")
  }
}

// MARK: Timeline

/// Dated events along one axis, a row per lane: dots for dates, bars for spans, each named where its
/// name has room; touch for the one nearest.
private struct TimelinePlot: View {
  let timeline: ChartSpec.Timeline
  @State private var selectedDate: Date?

  private struct Event: Identifiable {
    var index: Int
    var lane: Int
    var start: Date
    /// The end of a span's last day; nil for a single date.
    var end: Date?
    var id: Int { index }
    var last: Date { end ?? start }
  }

  private static let laneHeight: CGFloat = 40

  private var lanes: [String] { timeline.lanes }
  /// Events all in no lane are one row, with no lane axis.
  private var unnamed: Bool { lanes == [""] }

  /// In the phone's time zone, so a date's day and the axis agree.
  private var events: [Event] {
    let lanes = lanes
    return timeline.events.enumerated().compactMap { i, e in
      guard let date = ChartSpec.dateRange(e.date, in: .current) else { return nil }
      let end = e.end.flatMap { ChartSpec.dateRange($0, in: .current) }.map { $0.last.addingTimeInterval(86_400) }
      return Event(index: i, lane: lanes.firstIndex(of: e.lane ?? "") ?? 0, start: date.first, end: end)
    }
  }

  var body: some View {
    GeometryReader { geo in chart(width: geo.size.width) }
      .frame(height: CGFloat(lanes.count) * Self.laneHeight + 28)
  }

  private func chart(width: CGFloat) -> some View {
    let events = events
    let domain = self.domain(events)
    let named = self.named(events, domain: domain, width: width - (unnamed ? 0 : 96))
    let picked = selectedDate.flatMap { at in events.min { distance($0, at) < distance($1, at) } }
    return Chart {
      ForEach(events) { e in
        let event = timeline.events[e.index]
        let opacity = picked == nil || picked?.id == e.id ? 1.0 : 0.45
        if let end = e.end {
          BarMark(
            xStart: .value("Date", e.start), xEnd: .value("Date", end), y: .value("Lane", String(e.lane)),
            height: .fixed(8)
          )
          .foregroundStyle(ChartView.palette[0])
          .cornerRadius(4)
          .opacity(opacity)
          .annotation(position: .top, alignment: .leading, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
            if named.contains(e.index) { name(event.label) }
          }
          .accessibilityLabel(event.label)
          .accessibilityValue(ChartSpec.Timeline.when(event))
        } else {
          PointMark(x: .value("Date", e.start), y: .value("Lane", String(e.lane)))
            .symbol { ChartView.dot(ChartView.palette[0]) }
            .opacity(opacity)
            .annotation(position: .top, alignment: .leading, spacing: 2, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
              if named.contains(e.index) { name(event.label) }
            }
            .accessibilityLabel(event.label)
            .accessibilityValue(ChartSpec.Timeline.when(event))
        }
      }
      if let e = picked, let at = selectedDate {
        RuleMark(x: .value("Date", min(max(at, e.start), e.last)))
          .foregroundStyle(Color.secondary.opacity(0.4))
          .lineStyle(StrokeStyle(lineWidth: 1))
          .annotation(
            position: .top, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(e) }
          .accessibilityHidden(true)
      }
    }
    .chartXScale(domain: domain)
    .chartXAxis {
      AxisMarks(values: .automatic(desiredCount: 4)) { _ in
        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
        AxisValueLabel()
      }
    }
    .chartYScale(domain: lanes.indices.map(String.init))
    .chartYAxis {
      AxisMarks(position: .leading, values: lanes.indices.map(String.init)) { value in
        AxisValueLabel {
          if let key = value.as(String.self), let i = Int(key), lanes.indices.contains(i) {
            Text(lanes[i]).lineLimit(1).truncationMode(.middle).frame(maxWidth: 90, alignment: .leading)
          }
        }
      }
    }
    .chartYAxis(unnamed ? .hidden : .automatic)
    .chartXSelection(value: $selectedDate)
  }

  /// From the first date to the last, with room either side so the end dots aren't cut in half.
  private func domain(_ events: [Event]) -> ClosedRange<Date> {
    let lo = events.map(\.start).min() ?? .now
    let hi = events.map(\.last).max() ?? lo
    let pad = max(hi.timeIntervalSince(lo) * 0.04, 14 * 86_400)
    return lo.addingTimeInterval(-pad)...hi.addingTimeInterval(pad)
  }

  /// The events named beside their mark: in each lane, one whose name would run into the last one
  /// named is left to the readout. Widths are a caption's, roughly.
  private func named(_ events: [Event], domain: ClosedRange<Date>, width: CGFloat) -> Set<Int> {
    let span = domain.upperBound.timeIntervalSince(domain.lowerBound)
    var named: Set<Int> = []
    var reach: [Int: CGFloat] = [:]
    for e in events.sorted(by: { $0.start < $1.start }) {
      let w = CGFloat(timeline.events[e.index].label.count) * 6 + 6
      let x = min(CGFloat(e.start.timeIntervalSince(domain.lowerBound) / span) * width, width - w)
      if x >= reach[e.lane, default: -CGFloat.infinity] {
        named.insert(e.index)
        reach[e.lane] = x + w + 8
      }
    }
    return named
  }

  /// How far a date is from an event: 0 inside a span.
  private func distance(_ e: Event, _ at: Date) -> TimeInterval {
    at < e.start ? e.start.timeIntervalSince(at) : max(0, at.timeIntervalSince(e.last))
  }

  private func name(_ label: String) -> some View {
    Text(label).font(.caption2).foregroundStyle(.secondary).lineLimit(1).fixedSize()
  }

  private func readout(_ e: Event) -> some View {
    let event = timeline.events[e.index]
    return Readout {
      Text(event.label).fontWeight(.semibold)
      Text(ChartSpec.Timeline.when(event)).foregroundStyle(.secondary).monospacedDigit()
      if let lane = event.lane, !lane.isEmpty { Text(lane).foregroundStyle(.secondary) }
    }
  }
}
