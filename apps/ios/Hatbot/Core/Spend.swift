// The Spend page's numbers (web Spend.tsx) and the charts made of them.
import Foundation

struct SpendHour: Codable, Equatable, Sendable {
  /// The start of the hour, ISO.
  var hour: String
  var usd: Double
  var tokens: Int
}

struct SpendDay: Codable, Equatable, Sendable {
  /// A local date, "2026-10-15".
  var date: String
  var usd: Double
}

struct SpendByModel: Codable, Equatable, Sendable {
  var model: String
  var usd: Double
}

struct SpendByBot: Codable, Equatable, Sendable {
  var botId: String
  var usd: Double
}

struct SpendByPurpose: Codable, Equatable, Sendable {
  var purpose: String
  var costUsd: Double
}

/// A signed-in device or script: an API token.
struct ApiToken: Codable, Identifiable, Equatable, Sendable {
  let id: Int
  var name: String
  var createdAt: String
  var lastUsedAt: String?
}

/// The Spend page: each chart's numbers; one a brain doesn't have yet is empty.
struct SpendDetail: Equatable, Sendable {
  var hourly: [SpendHour] = []
  var daily: [SpendDay] = []
  var byModel: [SpendByModel] = []
  var byBot: [SpendByBot] = []
  var byPurpose: [SpendByPurpose] = []
}

extension AppStore {
  func loadSpendDetail() async throws -> SpendDetail {
    async let hourly: [SpendHour] = api.get("/spend/hourly?hours=24")
    async let daily: [SpendDay] = api.get("/spend/daily?days=30")
    async let byModel: [SpendByModel] = api.get("/spend/by-model?days=30")
    async let byBot: [SpendByBot]? = try? api.get("/spend/by-bot?days=30")
    async let byPurpose: [SpendByPurpose]? = try? api.get("/spend/by-purpose?days=30")
    return try await SpendDetail(
      hourly: hourly, daily: daily, byModel: byModel, byBot: byBot ?? [], byPurpose: byPurpose ?? [])
  }

  func loadTokens() async throws -> [ApiToken] {
    try await api.get("/tokens")
  }

  func revokeToken(_ id: Int) async throws {
    struct OK: Decodable {}
    let _: OK = try await api.delete("/tokens/\(id)")
  }

  /// Sends an approval that does nothing either way, to try the buttons on the phone.
  func sendTestApproval() async throws -> Approval {
    let a: Approval = try await api.post("/checks/approval", body: Empty())
    approvals[a.id] = a
    return a
  }
}

extension ChartSpec {
  init(
    type: Kind, title: String? = nil, unit: String? = nil, stacked: Bool = false, horizontal: Bool = false,
    x: [String], series: [Series]
  ) {
    self.type = type
    self.title = title
    self.unit = unit
    self.stacked = stacked
    self.horizontal = horizontal
    self.x = x
    self.series = series
  }
}

enum SpendCharts {
  static let purposeNames = [
    "thread": "Chat",
    "task": "Tasks",
    "heartbeat": "Heartbeat",
    "summary": "Summaries",
    "review": "Reviewing changes",
    "screening": "Screening",
    "expert": "Asking Opus",
    "research": "Research",
    "check": "Checks",
    "teach": "Teaching",
    "tidy": "Memory tidy-ups",
    "skill-fix": "Skill fixes",
    "boxes": "Boxes",
  ]

  static func hourly(_ hours: [SpendHour], timeZone: TimeZone = .current) -> ChartSpec? {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let x = hours.map { h in
      Format.date(h.hour).map { String(format: "%02d:00", calendar.component(.hour, from: $0)) } ?? h.hour
    }
    return bars(x: x, usd: hours.map(\.usd))
  }

  static func daily(_ days: [SpendDay]) -> ChartSpec? {
    bars(x: days.map { day($0.date) }, usd: days.map(\.usd))
  }

  /// Biggest first; ones that cost nothing left out.
  static func byModel(_ rows: [SpendByModel]) -> ChartSpec? {
    ranking(rows.map { (Format.modelName($0.model), $0.usd) })
  }

  static func byBot(_ rows: [SpendByBot], names: [String: String]) -> ChartSpec? {
    ranking(rows.map { (names[$0.botId] ?? $0.botId, $0.usd) })
  }

  static func byPurpose(_ rows: [SpendByPurpose]) -> ChartSpec? {
    ranking(rows.map { (purposeNames[$0.purpose] ?? $0.purpose.capitalized, $0.costUsd) })
  }

  /// "15 Oct" for "2026-10-15".
  static func day(_ date: String) -> String {
    let parts = date.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3, (1...12).contains(parts[1]) else { return date }
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return "\(parts[2]) \(months[parts[1] - 1])"
  }

  private static func bars(x: [String], usd: [Double]) -> ChartSpec? {
    guard !x.isEmpty else { return nil }
    return ChartSpec(type: .bar, unit: "$", x: x, series: [.init(name: "Spend", data: usd)])
  }

  private static func ranking(_ rows: [(String, Double)]) -> ChartSpec? {
    let shown = rows.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }.prefix(ChartSpec.maxRows)
    guard !shown.isEmpty else { return nil }
    return ChartSpec(
      type: .bar, unit: "$", horizontal: true, x: shown.map(\.0), series: [.init(name: "Spend", data: shown.map(\.1))])
  }
}
