// Hatbot on the home screen and in Control Center: today's spend and what needs you (small and
// medium), and a Pause all switch. They read the brain as you, through the App Group, like the share
// extension; iOS refreshes the widget about every 15 minutes, and the app asks it to when things change.
import AppIntents
import SwiftUI
import WidgetKit

@main
struct HatbotWidgets: WidgetBundle {
  var body: some Widget {
    StatusWidget()
    PauseControl()
  }
}

struct StatusEntry: TimelineEntry {
  var date = Date()
  var signedIn = true
  var today: Double?
  var dailyLimit: Double?
  var month: Double?
  var monthlyLimit: Double?
  var needsYou: Int?
}

struct StatusProvider: TimelineProvider {
  func placeholder(in context: Context) -> StatusEntry {
    StatusEntry(today: 1.24, dailyLimit: 5, month: 18.5, monthlyLimit: 60, needsYou: 0)
  }

  func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
    if context.isPreview { return completion(placeholder(in: context)) }
    Task { completion(await Self.load()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
    Task {
      let entry = await Self.load()
      completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }
  }

  static func load() async -> StatusEntry {
    guard let api = AppGroup.api() else { return StatusEntry(signedIn: false) }
    let spend: SpendSummary? = try? await api.get("/spend/summary")
    let pending: [Approval]? = try? await api.get("/approvals?pending=1")
    let desktop: DesktopState? = try? await api.get("/desktop/status")
    return StatusEntry(
      today: spend?.todayUsd, dailyLimit: spend?.limits.dailyUsd, month: spend?.monthUsd,
      monthlyLimit: spend?.limits.monthlyUsd,
      needsYou: pending.map { $0.count + (desktop?.request == nil ? 0 : 1) })
  }
}

struct StatusWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKinds.status, provider: StatusProvider()) { entry in
      StatusView(entry: entry)
        .containerBackground(.background, for: .widget)
        .widgetURL(URL(string: (entry.needsYou ?? 0) > 0 ? "hatbot://tasks" : "hatbot://new"))
    }
    .configurationDisplayName("Hatbot")
    .description("Today's spend, and what needs you.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct StatusView: View {
  let entry: StatusEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    if !entry.signedIn {
      Text("Sign in to Hatbot in the app.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    } else {
      HStack(alignment: .top) {
        figure("Today", money(entry.today, of: entry.dailyLimit))
        if family == .systemMedium {
          Spacer()
          figure("This month", money(entry.month, of: entry.monthlyLimit))
        }
        Spacer(minLength: 0)
      }
      .frame(maxHeight: .infinity, alignment: .top)
      .overlay(alignment: .bottomLeading) {
        if let n = entry.needsYou {
          Text(n == 0 ? "Nothing needs you" : n == 1 ? "1 needs you" : "\(n) need you")
            .font(.subheadline.weight(n > 0 ? .semibold : .regular))
            .foregroundStyle(n > 0 ? Color.orange : .secondary)
        }
      }
    }
  }

  private func figure(_ title: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.caption).foregroundStyle(.secondary)
      Text(value).font(.title3.weight(.semibold).monospacedDigit()).minimumScaleFactor(0.6).lineLimit(1)
    }
  }

  private func money(_ usd: Double?, of limit: Double?) -> String {
    guard let usd else { return "–" }
    guard let limit else { return Format.money(usd) }
    return "\(Format.money(usd)) of \(Format.money(limit))"
  }
}

/// Pause all in Control Center, on the Lock Screen or the Action button.
@available(iOS 18.0, *)
struct PauseControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: WidgetKinds.pause, provider: PausedValue()) { paused in
      ControlWidgetToggle("Pause all", isOn: paused, action: SetPausedIntent()) { on in
        Label(on ? "Paused" : "Working", systemImage: on ? "pause.circle.fill" : "pause.circle")
      }
    }
    .displayName("Pause Hatbot")
    .description("Stops everything Hatbot is doing, or lets it carry on.")
  }
}

@available(iOS 18.0, *)
struct PausedValue: ControlValueProvider {
  var previewValue: Bool { false }

  func currentValue() async throws -> Bool {
    guard let api = AppGroup.api() else { return false }
    let settings: AppSettings = try await api.get("/settings")
    return settings.paused
  }
}

/// Only on an unlocked phone, both ways: on a locked one anyone could resume Hatbot, or stop its work.
struct SetPausedIntent: SetValueIntent {
  static let title: LocalizedStringResource = "Pause Hatbot"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let description = IntentDescription("Pauses all of Hatbot's work, or resumes it.")

  @Parameter(title: "Paused")
  var value: Bool

  init() {}

  func perform() async throws -> some IntentResult {
    guard let api = AppGroup.api() else {
      throw APIError(status: 0, message: "Sign in to Hatbot in the app first.")
    }
    try await api.post(value ? "/pause-all" : "/resume")
    WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.status)
    return .result()
  }
}
