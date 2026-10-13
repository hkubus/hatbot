// Charts in replies: a ```chart fenced block holding this JSON (packages/shared/src/chart.ts).
// ChartView draws it; one that doesn't check out stays a code block.
import Foundation

struct ChartSpec: Decodable, Equatable, Sendable {
  enum Kind: String, Decodable, Sendable {
    case line, bar
  }

  struct Series: Decodable, Equatable, Sendable {
    var name: String?
    /// One value per x; nil is a gap.
    var data: [Double?]
  }

  /// Past three series the colours stop telling apart for colour-blind readers.
  static let maxSeries = 3
  static let maxPoints = 500
  /// Horizontal bars take a row each, so fewer of them.
  static let maxRows = 40

  var type: Kind
  var title: String?
  /// "%", "GiB", "ms", or a currency symbol ("$", "€"), which goes in front.
  var unit: String?
  /// Bars: the series stack into one bar per x, as parts of its total.
  var stacked: Bool
  /// Bars: one row per x, for rankings and long names.
  var horizontal: Bool
  var x: [String]
  var series: [Series]

  private enum CodingKeys: String, CodingKey {
    case type, title, unit, stacked, horizontal, x, series
  }

  /// x labels are strings or numbers.
  private struct Label: Decodable {
    var text: String
    init(from decoder: Decoder) throws {
      let c = try decoder.singleValueContainer()
      if let s = try? c.decode(String.self) {
        text = s
      } else {
        let n = try c.decode(Double.self)
        text = n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
      }
    }
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    type = try c.decode(Kind.self, forKey: .type)
    title = try c.decodeIfPresent(String.self, forKey: .title)
    unit = try c.decodeIfPresent(String.self, forKey: .unit)
    stacked = try c.decodeIfPresent(Bool.self, forKey: .stacked) ?? false
    horizontal = try c.decodeIfPresent(Bool.self, forKey: .horizontal) ?? false
    x = try c.decode([Label].self, forKey: .x).map(\.text)
    series = try c.decode([Series].self, forKey: .series)
  }

  /// The spec in a chart block, or nil if it isn't one.
  static func parse(_ source: String) -> ChartSpec? {
    guard let spec = try? JSONDecoder().decode(ChartSpec.self, from: Data(source.utf8)) else { return nil }
    guard (1...maxPoints).contains(spec.x.count), (1...maxSeries).contains(spec.series.count),
      spec.series.allSatisfy({ $0.data.count == spec.x.count }),
      spec.series.contains(where: { $0.data.contains { $0 != nil } }),
      !(spec.type == .bar && spec.horizontal) || spec.x.count <= maxRows
    else { return nil }
    return spec
  }

  /// Series names, with "Series 2" for one Hatbot left unnamed.
  var names: [String] {
    series.indices.map { i in
      let name = series[i].name ?? ""
      return name.isEmpty ? "Series \(i + 1)" : name
    }
  }

  /// Whether the bars stack: asked for, and more than one series to stack.
  var isStacked: Bool { type == .bar && stacked && series.count > 1 }

  /// Each x's stack of bars: (start, end) per series, positives up from 0 and negatives down.
  var stackSpans: [[(start: Double, end: Double)?]] {
    x.indices.map { i in
      var up = 0.0
      var down = 0.0
      return series.map { se -> (start: Double, end: Double)? in
        guard let v = se.data[i], v != 0 else { return nil }
        let start = v > 0 ? up : down
        if v > 0 { up += v } else { down += v }
        return (start, start + v)
      }
    }
  }

  /// The sum at each x, or nil where every series is a gap.
  var stackTotals: [Double?] {
    x.indices.map { i in
      let vs = series.compactMap { $0.data[i] }
      return vs.isEmpty ? nil : vs.reduce(0, +)
    }
  }

  /// 1,284 · 12.9K · 0.42 · $4.20 · 87% · 3.1 GiB. Compact from 1,000 up when `compact`.
  func format(_ v: Double, compact: Bool = false) -> String {
    let a = abs(v)
    let money = unit.map { "$€£¥₽₹".contains($0) && $0.count == 1 } ?? false
    var n: String
    if compact && a >= 1000 {
      let (scaled, suffix) = a >= 1e12 ? (v / 1e12, "T") : a >= 1e9 ? (v / 1e9, "B") : a >= 1e6 ? (v / 1e6, "M") : (v / 1e3, "K")
      n = Self.number(scaled, fraction: 0...1) + suffix
    } else if money && !compact && a < 100 {
      n = Self.number(v, fraction: v.truncatingRemainder(dividingBy: 1) == 0 ? 0...0 : 2...2)
    } else {
      n = Self.number(v, fraction: 0...(a >= 100 ? 0 : a >= 10 ? 1 : 2))
    }
    guard let unit, !unit.isEmpty else { return n }
    if money { return v < 0 ? "-\(unit)\(n.dropFirst())" : "\(unit)\(n)" }
    return unit == "%" ? "\(n)%" : "\(n) \(unit)"
  }

  private static func number(_ v: Double, fraction: ClosedRange<Int>) -> String {
    let f = NumberFormatter()
    f.locale = Locale(identifier: "en_US")
    f.numberStyle = .decimal
    f.roundingMode = .halfUp
    f.minimumFractionDigits = fraction.lowerBound
    f.maximumFractionDigits = fraction.upperBound
    return f.string(from: NSNumber(value: v)) ?? String(v)
  }
}
