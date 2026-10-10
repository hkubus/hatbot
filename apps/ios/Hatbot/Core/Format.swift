// Dates from the brain, task status lines, and cron in words (describeCron in packages/shared).
import Foundation

enum Format {
  /// The brain's timestamps: ISO 8601 in UTC, usually with milliseconds.
  static func date(_ iso: String?) -> Date? {
    guard let iso else { return nil }
    if let d = try? Date(iso, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
    return try? Date(iso, strategy: Date.ISO8601FormatStyle())
  }

  static func money(_ usd: Double) -> String {
    String(format: "$%.2f", usd)
  }

  /// The last line Hatbot wrote or thought.
  static func lastLine(_ text: String?) -> String? {
    text?.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }
  }

  /// What a task is doing, or how it ended.
  static func taskLine(_ t: AgentTask, progress: String?) -> String {
    if let summary = t.summary, !t.isActive { return summary }
    switch t.status {
    case .queued: return t.lane == .screen ? "Waiting for the screen." : "Queued."
    case .waitingApproval: return "Waiting for your approval."
    case .waitingTakeover: return "Waiting for you to take over."
    default: return lastLine(progress) ?? "Working…"
    }
  }

  static func statusLabel(_ s: TaskStatus) -> String {
    switch s {
    case .queued: "Queued"
    case .running: "Running"
    case .waitingApproval: "Needs approval"
    case .waitingTakeover: "Needs you"
    case .done: "Done"
    case .failed: "Failed"
    case .cancelled: "Cancelled"
    }
  }

  /// "Every day at 08:00", or "Once, Sat 11 Oct, 08:00".
  static func when(cron: String?, runAt: String?) -> String {
    if let cron { return describeCron(cron) }
    guard let date = date(runAt) else { return "" }
    return "Once, " + date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
  }

  private static let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  private static let nicknames = [
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
  ]

  private static func num(_ s: String) -> Int? {
    !s.isEmpty && s.allSatisfy(\.isASCII) && s.allSatisfy(\.isNumber) ? Int(s) : nil
  }

  private static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

  private static func ordinal(_ n: Int) -> String {
    let suffix =
      n % 10 == 1 && n != 11 ? "st" : n % 10 == 2 && n != 12 ? "nd" : n % 10 == 3 && n != 13 ? "rd" : "th"
    return "\(n)\(suffix)"
  }

  private static func list(_ items: [String]) -> String {
    items.count < 2 ? (items.first ?? "") : items.dropLast().joined(separator: ", ") + " and " + items.last!
  }

  private static func every(_ s: String) -> String? {
    s.hasPrefix("*/") && num(String(s.dropFirst(2))) != nil ? String(s.dropFirst(2)) : nil
  }

  /// "Every day at 08:00", "Weekdays at 07:30", "Every 15 minutes"; the expression itself when it's unusual.
  static func describeCron(_ expr: String) -> String {
    let trimmed = expr.trimmingCharacters(in: .whitespaces)
    let fields = (nicknames[trimmed.lowercased()] ?? trimmed).split(separator: " ").map(String.init)
    guard fields.count == 5 else { return expr }
    let (min, hour, dom, mon, dow) = (fields[0], fields[1], fields[2], fields[3], fields[4])

    if hour == "*" && dom == "*" && mon == "*" && dow == "*" {
      if min == "*" { return "Every minute" }
      if let n = every(min) { return "Every \(n) minutes" }
      if let m = num(min) { return m == 0 ? "Every hour" : "Every hour at :\(pad(m))" }
    }
    guard let m = num(min), mon == "*" else { return expr }
    if let n = every(hour), dom == "*", dow == "*" { return "Every \(n) hours" }
    let hours = hour.split(separator: ",").map { num(String($0)) }
    if hours.contains(where: { $0 == nil }) { return expr }
    let at = "at " + list(hours.map { "\(pad($0!)):\(pad(m))" })

    if dom == "*" && dow == "*" { return "Every day \(at)" }
    if dom == "*" {
      if dow == "1-5" { return "Weekdays \(at)" }
      if ["0,6", "6,0", "6-7"].contains(dow) { return "Weekends \(at)" }
      let parts = dow.split(separator: ",").map(String.init)
      if parts.contains(where: { num($0) == nil || num($0)! > 7 }) { return expr }
      let names = parts.map { days[num($0)! % 7] }
      if names.count == 1 { return "Every \(names[0]) \(at)" }
      return "\(list(names.map { String($0.prefix(3)) })) \(at)"
    }
    if dow == "*", let day = num(dom), (1...31).contains(day) {
      return "\(ordinal(day)) of the month \(at)"
    }
    return expr
  }
}
