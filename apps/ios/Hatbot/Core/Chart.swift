// A ```chart block's JSON (packages/shared/src/chart.ts). Line and bar keep their values in `x` and
// `series`; the other kinds each in their own part. One that doesn't check out stays a code block.
import Foundation

struct ChartSpec: Decodable, Equatable, Sendable {
  enum Kind: String, Decodable, Sendable {
    case line, bar, scatter, range, matrix, timeline
  }

  struct Series: Equatable, Sendable {
    var name: String?
    /// One value per x; nil is a gap.
    var data: [Double?]
  }

  struct Scatter: Decodable, Equatable, Sendable {
    struct Point: Decodable, Equatable, Sendable {
      var x: Double
      var y: Double
      var label: String?
    }

    struct Series: Decodable, Equatable, Sendable {
      var name: String?
      var points: [Point]
    }

    var xName: String?
    var xUnit: String?
    var yName: String?
    var yUnit: String?
    var series: [Series]

    var names: [String] { ChartSpec.names(series.map(\.name)) }
  }

  struct Ranges: Decodable, Equatable, Sendable {
    struct Row: Decodable, Equatable, Sendable {
      var label: String
      var low: Double
      var high: Double
      var mark: Double?
    }

    /// What the mark is: "median", "cheapest new".
    var markName: String?
    var rows: [Row]
  }

  struct Matrix: Decodable, Equatable, Sendable {
    enum Better: String, Decodable, Sendable {
      case high, low
    }

    struct Column: Decodable, Equatable, Sendable {
      var name: String
      var unit: String?
      /// Which end is better: low for prices and noise. Higher is better by default.
      var better: Better?
    }

    var rows: [String]
    var columns: [Column]
    /// One list per row, a value per column; nil where it isn't known.
    var values: [[Double?]]

    /// How good a cell is within its column, from 0 (its worst) to 1 (its best); nil for an unknown.
    /// A column whose values are all the same has nothing to tell apart, so all of it is 0.
    func shade(row: Int, column: Int) -> Double? {
      guard let v = values[row][column] else { return nil }
      let known = values.compactMap { $0[column] }
      guard let lo = known.min(), let hi = known.max(), hi > lo else { return 0 }
      let up = (v - lo) / (hi - lo)
      return columns[column].better == .low ? 1 - up : up
    }
  }

  struct Timeline: Decodable, Equatable, Sendable {
    struct Event: Decodable, Equatable, Sendable {
      /// 2024, 2024-03 or 2024-03-15.
      var date: String
      var end: String?
      var label: String
      var lane: String?
    }

    var events: [Event]

    /// Lane names in the order they first come; "" for events in none.
    var lanes: [String] {
      var seen: [String] = []
      for e in events where !seen.contains(e.lane ?? "") { seen.append(e.lane ?? "") }
      return seen
    }

    /// "2024", "Mar 2024" or "15 Mar 2024".
    static func dateText(_ date: String) -> String {
      let n = date.split(separator: "-").compactMap { Int($0) }
      let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
      guard n.count > 1, (1...12).contains(n[1]) else { return date }
      return n.count > 2 ? "\(n[2]) \(months[n[1] - 1]) \(n[0])" : "\(months[n[1] - 1]) \(n[0])"
    }

    static func when(_ e: Event) -> String {
      e.end.map { "\(dateText(e.date)) – \(dateText($0))" } ?? dateText(e.date)
    }
  }

  /// Past three series the colours stop telling apart for colour-blind readers.
  static let maxSeries = 3
  static let maxPoints = 500
  /// Horizontal bars and ranges take a row each, so fewer of them.
  static let maxRows = 40
  /// A matrix's columns share the width of a phone.
  static let maxColumns = 8
  static let maxEvents = 60
  /// Timeline lanes are told apart by row, not colour, but each needs its own row.
  static let maxLanes = 8

  var type: Kind
  var title: String?
  /// Line, bar and range: "%", "GiB", "ms", or a currency symbol ("$", "€"), which goes in front.
  var unit: String?
  /// Bars: the series stack into one bar per x, as parts of its total.
  var stacked = false
  /// Bars: one row per x, for rankings and long names.
  var horizontal = false
  var x: [String] = []
  var series: [Series] = []
  var scatter: Scatter?
  var ranges: Ranges?
  var matrix: Matrix?
  var timeline: Timeline?

  private enum CodingKeys: String, CodingKey {
    case type, title, unit, stacked, horizontal, x, series, markName, rows, columns, values, events, data
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
    // Values typed in and a file as well: which one is meant isn't clear, so neither is drawn.
    if c.contains(.data) {
      throw DecodingError.dataCorruptedError(forKey: .data, in: c, debugDescription: "values and a file")
    }
    title = try c.optional(.title)
    switch type {
    case .line, .bar:
      unit = try c.optional(.unit)
      stacked = try c.optional(.stacked) ?? false
      horizontal = try c.optional(.horizontal) ?? false
      x = try c.decode([Label].self, forKey: .x).map(\.text)
      series = try c.decode([Series].self, forKey: .series)
    case .scatter:
      scatter = try Scatter(from: decoder)
    case .range:
      unit = try c.optional(.unit)
      ranges = try Ranges(from: decoder)
    case .matrix:
      matrix = try Matrix(from: decoder)
    case .timeline:
      timeline = try Timeline(from: decoder)
    }
  }

  static func parse(_ source: String) -> ChartSpec? { parse(Data(source.utf8)) }

  static func parse(_ json: Data) -> ChartSpec? {
    guard let spec = try? JSONDecoder().decode(ChartSpec.self, from: json), spec.checksOut else { return nil }
    return spec
  }

  /// The shared spec's limits and rules, for the kind it is. Lengths are counted as JavaScript does.
  private var checksOut: Bool {
    guard fits(title, 120), fits(unit, 12) else { return false }
    switch type {
    case .line, .bar:
      return (1...Self.maxPoints).contains(x.count) && x.allSatisfy { fits($0, 60) }
        && (1...Self.maxSeries).contains(series.count)
        && series.allSatisfy { fits($0.name, 60) && $0.data.count == x.count }
        && series.contains { $0.data.contains { $0 != nil } }
        && (!(type == .bar && horizontal) || x.count <= Self.maxRows)
    case .scatter:
      guard let s = scatter else { return false }
      return fits(s.xName, 60) && fits(s.xUnit, 12) && fits(s.yName, 60) && fits(s.yUnit, 12)
        && (1...Self.maxSeries).contains(s.series.count)
        && s.series.allSatisfy { se in
          fits(se.name, 60) && !se.points.isEmpty && se.points.allSatisfy { isLabel($0.label) }
        }
        && s.series.reduce(0) { $0 + $1.points.count } <= Self.maxPoints
    case .range:
      guard let r = ranges else { return false }
      return fits(r.markName, 60) && (1...Self.maxRows).contains(r.rows.count)
        && r.rows.allSatisfy { row in
          isLabel(row.label) && row.low <= row.high && row.mark.map { $0 >= row.low && $0 <= row.high } ?? true
        }
    case .matrix:
      guard let m = matrix else { return false }
      return (1...Self.maxRows).contains(m.rows.count) && m.rows.allSatisfy { isLabel($0) }
        && (1...Self.maxColumns).contains(m.columns.count)
        && m.columns.allSatisfy { isLabel($0.name) && fits($0.unit, 12) }
        && m.values.count == m.rows.count && m.values.allSatisfy { $0.count == m.columns.count }
    case .timeline:
      guard let t = timeline else { return false }
      return (1...Self.maxEvents).contains(t.events.count)
        && t.events.allSatisfy { e in
          guard isLabel(e.label), fits(e.lane, 40), let start = Self.dateRange(e.date) else { return false }
          guard let end = e.end else { return true }
          return Self.dateRange(end).map { start.first <= $0.last } ?? false
        }
        && t.lanes.count <= Self.maxLanes
    }
  }

  private func fits(_ s: String?, _ max: Int) -> Bool { (s?.utf16.count ?? 0) <= max }
  private func isLabel(_ s: String?) -> Bool { s.map { (1...60).contains($0.utf16.count) } ?? true }

  /// Series names, with "Series 2" for one Hatbot left unnamed.
  var names: [String] { Self.names(series.map(\.name)) }

  static func names(_ given: [String?]) -> [String] {
    given.indices.map { i in
      let name = given[i] ?? ""
      return name.isEmpty ? "Series \(i + 1)" : name
    }
  }

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

  /// The first and last day a timeline date covers, at midnight in `timeZone`: 2024-03 is all of
  /// March. Nil if it isn't YYYY, YYYY-MM or YYYY-MM-DD. A day past the month's end rolls into the
  /// next month, as the web's Date.UTC does.
  static func dateRange(_ s: String, in timeZone: TimeZone = TimeZone(identifier: "UTC")!) -> (first: Date, last: Date)? {
    let parts = s.split(separator: "-", omittingEmptySubsequences: false)
    guard (1...3).contains(parts.count), parts.enumerated().allSatisfy({ i, p in
      p.count == (i == 0 ? 4 : 2) && p.allSatisfy { $0.isASCII && $0.isNumber }
    }) else { return nil }
    let n = parts.compactMap { Int($0) }
    if n.count > 1, !(1...12).contains(n[1]) { return nil }
    if n.count > 2, !(1...31).contains(n[2]) { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    // Counted on from 1 January, so month 13 and day 0 work out without leaning on lenient dates.
    func day(_ y: Int, _ m: Int, _ d: Int) -> Date? {
      calendar.date(from: DateComponents(year: y, month: 1, day: 1))
        .flatMap { calendar.date(byAdding: .month, value: m - 1, to: $0) }
        .flatMap { calendar.date(byAdding: .day, value: d - 1, to: $0) }
    }
    let first: Date?
    let last: Date?
    switch n.count {
    case 3:
      first = day(n[0], n[1], n[2])
      last = first
    case 2:
      first = day(n[0], n[1], 1)
      last = day(n[0], n[1] + 1, 0)
    default:
      first = day(n[0], 1, 1)
      last = day(n[0], 12, 31)
    }
    guard let first, let last else { return nil }
    return (first, last)
  }

  /// 1,284 · 12.9K · 0.42 · $4.20 · 87% · 3.1 GiB. Compact from 1,000 up when `compact`.
  func format(_ v: Double, compact: Bool = false) -> String {
    Self.format(v, unit: unit, compact: compact)
  }

  static func format(_ v: Double, unit: String?, compact: Bool = false) -> String {
    let a = abs(v)
    let money = unit.map { "$€£¥₽₹".contains($0) && $0.count == 1 } ?? false
    var n: String
    if compact && a >= 1000 {
      let (scaled, suffix) = a >= 1e12 ? (v / 1e12, "T") : a >= 1e9 ? (v / 1e9, "B") : a >= 1e6 ? (v / 1e6, "M") : (v / 1e3, "K")
      n = number(scaled, fraction: 0...1) + suffix
    } else if money && !compact && a < 100 {
      n = number(v, fraction: v.truncatingRemainder(dividingBy: 1) == 0 ? 0...0 : 2...2)
    } else {
      n = number(v, fraction: 0...(a >= 100 ? 0 : a >= 10 ? 1 : 2))
    }
    guard let unit, !unit.isEmpty else { return n }
    if money { return v < 0 ? "-\(unit)\(n.dropFirst())" : "\(unit)\(n)" }
    return unit == "%" ? "\(n)%" : "\(n) \(unit)"
  }

  /// Made once for each number of decimals `format` uses: a chart formats every tick and point as it's drawn.
  nonisolated(unsafe) private static let numbers = Dictionary(
    uniqueKeysWithValues: [0...0, 0...1, 0...2, 2...2].map { ($0, numberFormatter($0)) })

  private static func number(_ v: Double, fraction: ClosedRange<Int>) -> String {
    (numbers[fraction] ?? numberFormatter(fraction)).string(from: NSNumber(value: v)) ?? String(v)
  }

  private static func numberFormatter(_ fraction: ClosedRange<Int>) -> NumberFormatter {
    let f = NumberFormatter()
    f.locale = Locale(identifier: "en_US")
    f.numberStyle = .decimal
    f.roundingMode = .halfUp
    f.minimumFractionDigits = fraction.lowerBound
    f.maximumFractionDigits = fraction.upperBound
    return f
  }
}

/// A line, bar or scatter block with `"data": <attachment id>` in place of its values (`x` and
/// `series`). The brain reads the file (CSV or JSON), thins it to what a block may hold and answers
/// GET /attachments/:id/chart with the values; merged into the block's own keys, they make a ChartSpec
/// that goes through the same checks as one typed in.
struct ChartFile: Equatable, Sendable {
  var id: Int
  var type: ChartSpec.Kind
  var title: String?
  /// The block's keys less `data`, as JSON.
  private var keys: Data

  private struct Head: Decodable {
    var type: ChartSpec.Kind
    var data: Int
    var title: String?
  }

  static func parse(_ source: String) -> ChartFile? {
    let json = Data(source.utf8)
    guard let head = try? JSONDecoder().decode(Head.self, from: json), head.data > 0,
      [ChartSpec.Kind.line, .bar, .scatter].contains(head.type),
      var block = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any]
    else { return nil }
    block["data"] = nil
    let values = head.type == .scatter ? ["series"] : ["x", "series"]
    guard !values.contains(where: { block[$0] != nil }),
      let keys = try? JSONSerialization.data(withJSONObject: block)
    else { return nil }
    let file = ChartFile(id: head.data, type: head.type, title: head.title, keys: keys)
    // The rest of the block (title, unit, names) checks out the same way a typed one does, so it's
    // tried with a single made-up value.
    let stand = head.type == .scatter
      ? #"{"series":[{"points":[{"x":0,"y":0}]}]}"#
      : #"{"x":[0],"series":[{"data":[0]}]}"#
    return file.spec(merging: Data(stand.utf8)) == nil ? nil : file
  }

  /// The chart with the brain's values in it, or nil if they don't check out. Only the values are
  /// taken from the answer; the title and units stay the block's.
  func spec(merging response: Data) -> ChartSpec? {
    guard var block = (try? JSONSerialization.jsonObject(with: keys)) as? [String: Any],
      let answer = (try? JSONSerialization.jsonObject(with: response)) as? [String: Any]
    else { return nil }
    for key in type == .scatter ? ["series"] : ["x", "series"] { block[key] = answer[key] }
    return (try? JSONSerialization.data(withJSONObject: block)).flatMap { ChartSpec.parse($0) }
  }

  /// The brain's answers by server, file and kind, kept for the session: the chat draws its charts
  /// again as you scroll.
  nonisolated(unsafe) private static let answers = NSCache<NSString, CacheBox<Data>>()

  /// The chart, fetched; nil if the values don't check out. Throws APIError with the brain's sentence
  /// when it can't make one from the file.
  func load(_ api: API) async throws -> ChartSpec? {
    let path = "/attachments/\(id)/chart?type=\(type.rawValue)"
    let key = NSString(string: api.server.absoluteString + path)
    if let hit = Self.answers.object(forKey: key) { return spec(merging: hit.value) }
    let data = try await api.data(path)
    Self.answers.setObject(CacheBox(data), forKey: key)
    return spec(merging: data)
  }

  /// Signed out.
  static func clear() {
    answers.removeAllObjects()
  }
}

// Decoded here rather than synthesized so a field the spec makes optional can be left out but not
// sent as null, as the shared spec has it. In an extension, Series keeps its memberwise init.
extension ChartSpec.Series: Decodable {
  private enum CodingKeys: String, CodingKey { case name, data }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.optional(.name)
    data = try c.decode([Double?].self, forKey: .data)
  }
}

extension ChartSpec.Scatter {
  private enum CodingKeys: String, CodingKey { case xName, xUnit, yName, yUnit, series }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    xName = try c.optional(.xName)
    xUnit = try c.optional(.xUnit)
    yName = try c.optional(.yName)
    yUnit = try c.optional(.yUnit)
    series = try c.decode([Series].self, forKey: .series)
  }
}

extension ChartSpec.Scatter.Point {
  private enum CodingKeys: String, CodingKey { case x, y, label }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    x = try c.decode(Double.self, forKey: .x)
    y = try c.decode(Double.self, forKey: .y)
    label = try c.optional(.label)
  }
}

extension ChartSpec.Scatter.Series {
  private enum CodingKeys: String, CodingKey { case name, points }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.optional(.name)
    points = try c.decode([ChartSpec.Scatter.Point].self, forKey: .points)
  }
}

extension ChartSpec.Ranges {
  private enum CodingKeys: String, CodingKey { case markName, rows }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    markName = try c.optional(.markName)
    rows = try c.decode([Row].self, forKey: .rows)
  }
}

extension ChartSpec.Ranges.Row {
  private enum CodingKeys: String, CodingKey { case label, low, high, mark }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    label = try c.decode(String.self, forKey: .label)
    low = try c.decode(Double.self, forKey: .low)
    high = try c.decode(Double.self, forKey: .high)
    mark = try c.optional(.mark)
  }
}

extension ChartSpec.Matrix.Column {
  private enum CodingKeys: String, CodingKey { case name, unit, better }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    unit = try c.optional(.unit)
    better = try c.optional(.better)
  }
}

extension ChartSpec.Timeline.Event {
  private enum CodingKeys: String, CodingKey { case date, end, label, lane }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    date = try c.decode(String.self, forKey: .date)
    end = try c.optional(.end)
    label = try c.decode(String.self, forKey: .label)
    lane = try c.optional(.lane)
  }
}

private extension KeyedDecodingContainer {
  /// A value that may be left out, but isn't null when it's there.
  func optional<T: Decodable>(_ key: Key) throws -> T? {
    contains(key) ? try decode(T.self, forKey: key) : nil
  }
}
