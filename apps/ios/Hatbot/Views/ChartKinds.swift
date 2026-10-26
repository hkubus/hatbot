// The chart kinds that aren't axes and marks: meters, calendars, treemaps, comparisons, a haggle's
// offers and a listing's photos. ChartView picks one by the spec's type.
import Charts
import SwiftUI

// MARK: Meter

struct MeterList: View {
  let meter: ChartSpec.Meter
  let unit: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(meter.rows.indices, id: \.self) { i in row(meter.rows[i]) }
    }
  }

  private func row(_ r: ChartSpec.Meter.Row) -> some View {
    let value = ChartSpec.format(r.value, unit: unit)
    let limit = ChartSpec.format(r.max, unit: unit)
    let full = min(1, r.value / r.max)
    return VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(r.label).lineLimit(1)
        Spacer(minLength: 0)
        Text("\(value) / \(limit)").monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
      }
      .font(.caption)
      RoundedRectangle(cornerRadius: 4).fill(.quaternary)
        .frame(height: 8)
        .overlay(alignment: .leading) {
          GeometryReader { geo in
            RoundedRectangle(cornerRadius: 4)
              .fill(r.warning ? Color.red : ChartView.palette[0])
              .frame(width: geo.size.width * full)
          }
        }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(r.label)
    .accessibilityValue("\(value) of \(limit)")
  }
}

// MARK: Calendar

struct CalendarGrid: View {
  let days: ChartSpec.Days
  let unit: String?
  @State private var picked: Date?

  private static let cell: CGFloat = 11
  private static let gap: CGFloat = 2
  private static let monthsHeight: CGFloat = 14
  private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

  private static let utc: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
  }()

  /// Each day's value by its UTC midnight.
  private var values: [Date: Double] {
    Dictionary(
      days.days.compactMap { d in ChartSpec.dateRange(d.date).map { ($0.first, d.value) } },
      uniquingKeysWith: { _, last in last })
  }

  var body: some View {
    let weeks = ChartSpec.calendarWeeks(days.days.map(\.date))
    let values = values
    // From zero, or the lowest value if it's below: a day at the bottom shows as one with nothing.
    let lo = min(0, values.values.min() ?? 0)
    let hi = values.values.max() ?? 0
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 4) {
        VStack(alignment: .leading, spacing: Self.gap) {
          Color.clear.frame(width: 1, height: Self.monthsHeight)
          ForEach(0..<7, id: \.self) { d in
            Text(d == 0 ? "Mon" : d == 2 ? "Wed" : d == 4 ? "Fri" : "")
              .font(.caption2)
              .foregroundStyle(.secondary)
              .fixedSize()
              .frame(height: Self.cell)
          }
        }
        ScrollView(.horizontal, showsIndicators: false) {
          VStack(alignment: .leading, spacing: Self.gap) {
            HStack(spacing: Self.gap) {
              ForEach(weeks.indices, id: \.self) { w in
                Color.clear.frame(width: Self.cell, height: Self.monthsHeight)
                  .overlay(alignment: .topLeading) {
                    if let m = month(weeks[w]) {
                      Text(m).font(.caption2).foregroundStyle(.secondary).fixedSize()
                    }
                  }
              }
            }
            // A month starting in the last week has its name run past the grid.
            .padding(.trailing, weeks.last.flatMap { month($0) } == nil ? 0 : 16)
            HStack(alignment: .top, spacing: Self.gap) {
              ForEach(weeks.indices, id: \.self) { w in
                VStack(spacing: Self.gap) {
                  ForEach(0..<7, id: \.self) { d in cell(weeks[w][d], values: values, lo: lo, hi: hi) }
                }
              }
            }
          }
        }
        .defaultScrollAnchor(.trailing)
      }
      if let picked {
        Text("\(dayText(picked)): \(values[picked].map { ChartSpec.format($0, unit: unit) } ?? "–")")
          .font(.caption2)
          .monospacedDigit()
      }
    }
  }

  /// The month a week has the 1st of, short.
  private func month(_ week: [Date]) -> String? {
    week.first { Self.utc.component(.day, from: $0) == 1 }.map { Self.months[Self.utc.component(.month, from: $0) - 1] }
  }

  private func dayText(_ day: Date) -> String {
    let c = Self.utc.dateComponents([.year, .month, .day], from: day)
    return "\(c.day ?? 1) \(Self.months[(c.month ?? 1) - 1]) \(c.year ?? 0)"
  }

  private func cell(_ day: Date, values: [Date: Double], lo: Double, hi: Double) -> some View {
    let value = values[day]
    let s = value.map { hi == lo ? 1 : ($0 - lo) / (hi - lo) } ?? 0
    let fill = s > 0 ? AnyShapeStyle(ChartView.palette[0].opacity(0.2 + 0.8 * s)) : AnyShapeStyle(.quaternary)
    return RoundedRectangle(cornerRadius: 2)
      .fill(fill)
      .frame(width: Self.cell, height: Self.cell)
      .overlay {
        if picked == day { RoundedRectangle(cornerRadius: 2).strokeBorder(.primary, lineWidth: 1) }
      }
      .contentShape(Rectangle())
      .onTapGesture { picked = picked == day ? nil : day }
      .accessibilityLabel(dayText(day))
      .accessibilityValue(value.map { ChartSpec.format($0, unit: unit) } ?? "Nothing")
  }
}

// MARK: Treemap

struct TreemapPlot: View {
  let treemap: ChartSpec.Treemap
  let unit: String?
  @State private var picked: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      GeometryReader { geo in
        let tiles = ChartSpec.treemap(treemap.items.map(\.value), Double(geo.size.width), Double(geo.size.height))
        let top = treemap.items.map(\.value).max() ?? 1
        ZStack(alignment: .topLeading) {
          ForEach(tiles, id: \.i) { t in tile(t, top: top) }
        }
      }
      .frame(height: 220)
      if let i = picked, treemap.items.indices.contains(i) {
        let item = treemap.items[i]
        Text("\(item.label): \(ChartSpec.format(item.value, unit: unit))").font(.caption2).monospacedDigit()
      }
    }
  }

  private func tile(_ t: ChartSpec.Tile, top: Double) -> some View {
    let item = treemap.items[t.i]
    let value = ChartSpec.format(item.value, unit: unit)
    // Light enough that the label on it reads in either mode.
    return RoundedRectangle(cornerRadius: 4)
      .fill(ChartView.palette[0].opacity(0.1 + 0.4 * item.value / top))
      .overlay(alignment: .topLeading) {
        if t.w >= 56 && t.h >= 30 {
          VStack(alignment: .leading, spacing: 1) {
            Text(item.label).font(.caption).lineLimit(2)
            Text(value).font(.caption2).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
          }
          .padding(5)
        }
      }
      .overlay {
        if picked == t.i { RoundedRectangle(cornerRadius: 4).strokeBorder(.primary, lineWidth: 1.5) }
      }
      .clipShape(.rect(cornerRadius: 4))
      .frame(width: max(0, CGFloat(t.w) - 2), height: max(0, CGFloat(t.h) - 2))
      .offset(x: CGFloat(t.x) + 1, y: CGFloat(t.y) + 1)
      .onTapGesture { picked = picked == t.i ? nil : t.i }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(item.label)
      .accessibilityValue(value)
  }
}

// MARK: Compare

struct CompareGrid: View {
  let compare: ChartSpec.Compare

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 3, verticalSpacing: 3) {
        GridRow {
          Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
          ForEach(compare.columns.indices, id: \.self) { c in
            Text(compare.columns[c])
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
              .lineLimit(2)
              .frame(maxWidth: 160, alignment: .leading)
              .padding(.horizontal, 8)
          }
        }
        ForEach(compare.rows.indices, id: \.self) { r in
          GridRow {
            Text(compare.rows[r].label)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
              .frame(maxWidth: 120, alignment: .leading)
            ForEach(compare.columns.indices, id: \.self) { c in cell(compare.rows[r], c) }
          }
        }
      }
    }
  }

  private func cell(_ row: ChartSpec.Compare.Row, _ c: Int) -> some View {
    let value = row.values[c]
    let best = row.best == c
    return Text(value ?? "–")
      .font(.caption.weight(best ? .semibold : .regular))
      .foregroundStyle(value == nil || row.alike ? HierarchicalShapeStyle.secondary : .primary)
      .lineLimit(3)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .frame(minWidth: 72, maxWidth: 160, alignment: .leading)
      .background(best ? ChartView.palette[0].opacity(0.18) : .clear, in: .rect(cornerRadius: 6))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(row.label), \(compare.columns[c])")
      .accessibilityValue(value ?? "Not known")
  }
}

// MARK: Offers

struct OffersPlot: View {
  let offers: ChartSpec.Offers
  let unit: String?
  @State private var selectedTurn: Int?

  private struct Turn: Identifiable {
    /// From 1.
    var id: Int
    var offer: ChartSpec.Offers.Offer
    var side: Int { offer.by == .you ? 0 : 1 }
  }

  private var turns: [Turn] { offers.offers.enumerated().map { Turn(id: $0.offset + 1, offer: $0.element) } }
  private var names: [String] { ["You", offers.themName] }
  private var selected: Turn? { selectedTurn.flatMap { t in turns.first { $0.id == t } } }

  var body: some View {
    let turns = turns
    let names = names
    let n = turns.count
    let step = max(1, Int((Double(n) / 6).rounded(.up)))
    Chart {
      ForEach(turns) { t in
        LineMark(x: .value("Turn", t.id), y: .value("Price", t.offer.price), series: .value("Side", names[t.side]))
          .foregroundStyle(by: .value("Side", names[t.side]))
          .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
          .accessibilityHidden(true)
        PointMark(x: .value("Turn", t.id), y: .value("Price", t.offer.price))
          .symbol { ChartView.dot(ChartView.palette[t.side]) }
          .accessibilityLabel("Turn \(t.id), \(names[t.side])")
          .accessibilityValue(ChartSpec.format(t.offer.price, unit: unit))
      }
      if let limit = offers.limit {
        RuleMark(y: .value("Price", limit))
          .foregroundStyle(Color.secondary)
          .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
          .annotation(
            position: .top, alignment: .trailing, spacing: 2,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) {
            Text("Limit").font(.caption2).foregroundStyle(.secondary)
          }
          .accessibilityLabel("Limit")
          .accessibilityValue(ChartSpec.format(limit, unit: unit))
      }
      if let t = selected {
        RuleMark(x: .value("Turn", t.id))
          .foregroundStyle(Color.secondary.opacity(0.4))
          .lineStyle(StrokeStyle(lineWidth: 1))
          .annotation(
            position: .top, spacing: 0,
            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
          ) { readout(t, names: names) }
          .accessibilityHidden(true)
      }
    }
    .chartXScale(domain: n == 1 ? 0...2 : 1...n)
    .chartXAxis {
      AxisMarks(values: Array(stride(from: 1, through: n, by: step))) { value in
        AxisValueLabel {
          if let i = value.as(Int.self) { Text("\(i)") }
        }
      }
    }
    .chartYScale(domain: .automatic(includesZero: false))
    .chartYAxis { valueMarks(unit: unit, position: .leading) }
    .chartXSelection(value: $selectedTurn)
    .chartForegroundStyleScale(domain: names, range: Array(ChartView.palette.prefix(2)))
    .chartLegend(position: .top, alignment: .leading)
    .frame(height: ChartView.height + 24)
  }

  private func readout(_ t: Turn, names: [String]) -> some View {
    Readout {
      Text("Turn \(t.id): \(names[t.side]) \(ChartSpec.format(t.offer.price, unit: unit))")
        .fontWeight(.semibold)
        .monospacedDigit()
      if let note = t.offer.note, !note.isEmpty { Text(note).foregroundStyle(.secondary) }
    }
  }
}

// MARK: Gallery

struct GalleryRow: View {
  static let width: CGFloat = 280
  let gallery: ChartSpec.Gallery

  var body: some View {
    let link = gallery.url.flatMap { URL(string: $0) }
    ScrollView(.horizontal, showsIndicators: false) {
      LazyHStack(spacing: 8) {
        ForEach(gallery.photos.indices, id: \.self) { i in
          if let link {
            Link(destination: link) { ListingPhoto(url: gallery.photos[i], width: Self.width) }
              .buttonStyle(.plain)
          } else {
            ListingPhoto(url: gallery.photos[i], width: Self.width)
          }
        }
      }
      .scrollTargetLayout()
    }
    .scrollTargetBehavior(.viewAligned)
  }
}
