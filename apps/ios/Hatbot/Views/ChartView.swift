// A ```chart block in a reply, drawn with Swift Charts in Hatbot's colours (the web's chart.tsx):
// a line or bar chart; touch and drag for the values at a point.
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

  private var single: Bool { spec.series.count == 1 }
  private var n: Int { spec.x.count }
  private var selected: Int? {
    let i = spec.type == .bar ? selectedBar.flatMap { Int($0) } : selectedPoint
    return i.flatMap { spec.x.indices.contains($0) ? $0 : nil }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let title = spec.title, !title.isEmpty {
        Text(title).font(.footnote.weight(.semibold))
      }
      GeometryReader { geo in
        if spec.type == .bar { bars(width: geo.size.width) } else { lines(width: geo.size.width) }
      }
      .frame(height: single ? Self.height : Self.height + 24)
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
      }
      if let i = selected {
        RuleMark(x: .value("x", i))
          .foregroundStyle(Color.secondary.opacity(0.4))
          .lineStyle(StrokeStyle(lineWidth: 1))
          .annotation(
            position: .top, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(i) }
      }
      ForEach(dots) { p in
        PointMark(x: .value("x", p.index), y: .value("Value", p.value))
          .symbol { dot(p.series) }
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
    let k = spec.series.count
    let band = max(1, (width - 44) / CGFloat(n))
    let group = min(band * 0.72, CGFloat(24 * k + 2 * (k - 1)))
    let bar = max(1, min(24, (group - CGFloat(2 * (k - 1))) / CGFloat(k)))
    return Chart {
      ForEach(points) { p in
        BarMark(x: .value("x", String(p.index)), y: .value("Value", p.value), width: .fixed(bar))
          .foregroundStyle(by: .value("Series", spec.names[p.series]))
          .position(by: .value("Series", spec.names[p.series]), axis: .horizontal, span: .fixed(group))
          .cornerRadius(4)
          .opacity(selected == nil || selected == p.index ? 1 : 0.45)
      }
      RuleMark(y: .value("Value", 0))
        .foregroundStyle(Color.secondary.opacity(0.5))
        .lineStyle(StrokeStyle(lineWidth: 1))
      if let i = selected {
        RuleMark(x: .value("x", String(i)))
          .foregroundStyle(.clear)
          .annotation(
            position: .top, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(i) }
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

  /// An 8pt dot with a 2pt ring of the bubble's colour, so it stays clear where lines cross.
  private func dot(_ series: Int) -> some View {
    Circle()
      .fill(Self.palette[series])
      .frame(width: 8, height: 8)
      .padding(2)
      .background(Circle().fill(Color.botBubble))
  }

  /// The values at one x: value first, then the series.
  private func readout(_ i: Int) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(spec.x[i]).foregroundStyle(.secondary)
      ForEach(spec.series.indices, id: \.self) { s in
        HStack(spacing: 5) {
          Capsule().fill(Self.palette[s]).frame(width: 10, height: 2)
          Text(spec.series[s].data[i].map { spec.format($0) } ?? "–").fontWeight(.semibold).monospacedDigit()
          if !single { Text(spec.names[s]).foregroundStyle(.secondary) }
        }
      }
    }
    .font(.caption2)
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(.background, in: .rect(cornerRadius: 8))
    .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 0.5) }
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
