import Foundation

/// Worked out once a day: at midnight "Today" becomes "Yesterday".
final class TimeLabels {
  private var day: Date?
  private var labels: [Int: String] = [:]

  func label(_ m: ThreadMessage, after previous: ThreadMessage?, now: Date = .now) -> String? {
    guard let date = m.date else { return nil }
    if let prev = previous?.date, date.timeIntervalSince(prev) < 3600 { return nil }
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: now)
    if today != day {
      day = today
      labels = [:]
    }
    if let hit = labels[m.id] { return hit }
    let label = Self.label(date, now: now, today: today, calendar: calendar)
    labels[m.id] = label
    return label
  }

  private static func label(_ date: Date, now: Date, today: Date, calendar: Calendar) -> String {
    let time = date.formatted(date: .omitted, time: .shortened)
    if calendar.isDate(date, inSameDayAs: now) { return "Today \(time)" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), calendar.isDate(date, inSameDayAs: yesterday) {
      return "Yesterday \(time)"
    }
    if let weekAgo = calendar.date(byAdding: .day, value: -6, to: today), date >= weekAgo {
      return "\(date.formatted(.dateTime.weekday(.wide))) \(time)"
    }
    let thisYear = calendar.isDate(date, equalTo: now, toGranularity: .year)
    let day = thisYear
      ? date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
      : date.formatted(.dateTime.day().month(.abbreviated).year())
    return "\(day) at \(time)"
  }
}
