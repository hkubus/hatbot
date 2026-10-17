// Settings: spend against the limits, Schedules & Triggers, watchers, Check everything, the heartbeat
// and weekly report, chat effort, what notifications open, Pause all (PLAN.md §6.5), and signing out.
import SwiftUI

struct SettingsView: View {
  @Binding var path: [Route]
  @Environment(Session.self) private var session
  @Environment(AppStore.self) private var store
  @State private var settings: AppSettings?
  @State private var spend: SpendSummary?
  @State private var confirmPause = false
  @State private var confirmSignOut = false
  @State private var error: String?
  /// Changes made here; an answer for one that a later change has overtaken isn't shown.
  @State private var changes = 0

  var body: some View {
    NavigationStack(path: $path) {
      Form {
        if let error {
          Text(error).foregroundStyle(.red)
        }
        Section("Spend") {
          LabeledContent("Today", value: spendText(store.todayUsd, limit: spend?.limits.dailyUsd))
          LabeledContent("This month", value: spendText(store.monthUsd, limit: spend?.limits.monthlyUsd))
          if let tokens = spend?.todayTokens {
            LabeledContent("Tokens today", value: Format.tokens(tokens))
          }
          if let hour = spend?.lastHour {
            LabeledContent("Last hour", value: "\(Format.money(hour.usd)) · \(Format.tokens(hour.tokens)) tokens")
          }
          if let minute = spend?.lastMinute {
            LabeledContent(
              "Last minute", value: "\(String(format: "$%.3f", minute.usd)) · \(Format.tokens(minute.tokens)) tokens")
          }
          NavigationLink("Spend by hour, day, model and bot", value: Route.spend)
          NavigationLink("Limits", value: Route.limits)
        }
        Section {
          NavigationLink("Schedules & Triggers", value: Route.schedules)
          NavigationLink("Watchers", value: Route.watchers)
        }
        Section("Looking after things") {
          NavigationLink("Check everything", value: Route.checks)
          NavigationLink("Heartbeat", value: Route.heartbeat)
          if let report = settings?.weeklyReport {
            Toggle("Weekly report", isOn: weeklyReport(report, \.enabled))
            if report.enabled {
              Picker("Day", selection: weeklyReport(report, \.weekday)) {
                ForEach(0..<7, id: \.self) { d in Text(Calendar.current.weekdaySymbols[d]).tag(d) }
              }
              Picker("Time", selection: weeklyReport(report, \.hour)) {
                ForEach(0..<24, id: \.self) { h in Text(String(format: "%02d:00", h)).tag(h) }
              }
            }
            Button("Send the report now") {
              Task {
                await act {
                  _ = try await store.sendReport()
                  store.toast = "Sent to the chat"
                }
              }
            }
          }
          if let tidy = settings?.memoryTidy {
            Toggle(
              "Propose a memory tidy-up weekly",
              isOn: newerSetting(tidy, \.memoryTidy) { try await store.setMemoryTidy($0.memoryTidy ?? tidy) })
          }
        }
        if let settings {
          Section("Chat") {
            if let model = settings.chatModel {
              Picker(
                "Model", selection: newerSetting(model, \.chatModel) { try await store.setChatModel($0.chatModel ?? model) }
              ) {
                Text("Haiku 5.5, asks Opus for hard parts").tag(AppSettings.ChatModel.haiku)
                Text("Opus 5.5").tag(AppSettings.ChatModel.opus)
                // One set elsewhere that this app doesn't know: shown as it is.
                if !AppSettings.ChatModel.known.contains(model) { Text(model.rawValue).tag(model) }
              }
            }
            Picker(
              "Effort", selection: setting(settings.chatEffort, \.chatEffort) { try await store.setChatEffort($0.chatEffort) }
            ) {
              Text("Low").tag(AppSettings.Effort.low)
              Text("Medium").tag(AppSettings.Effort.medium)
              if !AppSettings.Effort.known.contains(settings.chatEffort) {
                Text(settings.chatEffort.rawValue.capitalized).tag(settings.chatEffort)
              }
            }
          }
          if let model = settings.taskModel {
            Section("Tasks") {
              Picker(
                "Model for background tasks",
                selection: newerSetting(model, \.taskModel) { try await store.setTaskModel($0.taskModel ?? model) }
              ) {
                Text("Haiku 5.5").tag(AppSettings.TaskModel.haiku)
                Text("Opus 5.5").tag(AppSettings.TaskModel.opus)
                if !AppSettings.TaskModel.known.contains(model) { Text(model.rawValue).tag(model) }
              }
            }
          }
          if let model = settings.desktopModel {
            Section("Desktop") {
              Picker(
                "Model for desktop tasks",
                selection: newerSetting(model, \.desktopModel) { try await store.setDesktopModel($0.desktopModel ?? model) }
              ) {
                Text("Haiku 5.5").tag(AppSettings.DesktopModel.haiku)
                Text("Opus 5.5").tag(AppSettings.DesktopModel.opus)
                if !AppSettings.DesktopModel.known.contains(model) { Text(model.rawValue).tag(model) }
              }
              if model == .haiku, let escalate = settings.desktopEscalate {
                Toggle(
                  "Try again on Opus when Haiku fails",
                  isOn: newerSetting(escalate, \.desktopEscalate) {
                    try await store.setDesktopEscalate($0.desktopEscalate ?? escalate)
                  })
              }
            }
          }
          // Brains from before the setting don't have it.
          if let opens = settings.notificationsOpen {
            Section {
              Picker(
                "Tapping one opens",
                selection: newerSetting(opens, \.notificationsOpen) {
                  try await store.setNotificationsOpen($0.notificationsOpen ?? opens)
                }
              ) {
                Text("The web app").tag(AppSettings.Opens.web)
                Text("This app").tag(AppSettings.Opens.app)
              }
            } header: {
              Text("Notifications")
            } footer: {
              Text("Notifications come from the ntfy app.")
            }
          }
        }
        Section("Safety") {
          if let review = settings?.reviewChanges {
            Toggle(
              "Let Haiku allow safe changes",
              isOn: newerSetting(review, \.reviewChanges) { try await store.setReviewChanges($0.reviewChanges ?? review) })
          }
          if store.paused {
            Button("Resume") { Task { await act { try await store.setPaused(false) } } }
          } else {
            Button("Pause all", role: .destructive) { confirmPause = true }
          }
        }
        Section {
          LabeledContent("Server", value: store.api.server.host() ?? store.api.server.absoluteString)
          NavigationLink("Signed-in devices", value: Route.devices)
          Button("Sign out", role: .destructive) { confirmSignOut = true }
        }
      }
      .navigationTitle("Settings")
      .sidebarButton()
      .confirmationDialog("Pause all?", isPresented: $confirmPause, titleVisibility: .visible) {
        Button("Pause all", role: .destructive) { Task { await act { try await store.setPaused(true) } } }
      }
      .confirmationDialog("Sign out of Hatbot?", isPresented: $confirmSignOut, titleVisibility: .visible) {
        Button("Sign out", role: .destructive) { Task { await session.signOut() } }
      }
      .task { await load() }
      .refreshable { await load() }
      .onChange(of: store.settingsVersion) { Task { await load() } }
      .routes()
    }
  }

  private func spendText(_ usd: Double?, limit: Double?) -> String {
    guard let usd else { return "–" }
    guard let limit else { return Format.money(usd) }
    return "\(Format.money(usd)) of \(Format.money(limit))"
  }

  /// A setting's control. A change shows at once, as the switch or picker moved, and is saved behind it;
  /// if saving fails, it goes back and says why.
  private func setting<V>(
    _ current: V, _ key: WritableKeyPath<AppSettings, V>, save: @escaping (AppSettings) async throws -> AppSettings
  ) -> Binding<V> {
    Binding(
      get: { settings?[keyPath: key] ?? current },
      set: { value in change({ $0[keyPath: key] = value }, save: save) })
  }

  /// The same, for a setting older brains don't have.
  private func newerSetting<V>(
    _ current: V, _ key: WritableKeyPath<AppSettings, V?>, save: @escaping (AppSettings) async throws -> AppSettings
  ) -> Binding<V> {
    Binding(
      get: { settings?[keyPath: key] ?? current },
      set: { value in change({ $0[keyPath: key] = value }, save: save) })
  }

  private func weeklyReport<V>(
    _ current: AppSettings.WeeklyReport, _ key: WritableKeyPath<AppSettings.WeeklyReport, V>
  ) -> Binding<V> {
    Binding(
      get: { (settings?.weeklyReport ?? current)[keyPath: key] },
      set: { value in
        change({ s in
          var report = s.weeklyReport ?? current
          report[keyPath: key] = value
          s.weeklyReport = report
        }) { try await store.setWeeklyReport($0.weeklyReport ?? current) }
      })
  }

  private func change(_ edit: (inout AppSettings) -> Void, save: @escaping (AppSettings) async throws -> AppSettings) {
    guard let before = settings else { return }
    var next = before
    edit(&next)
    settings = next
    changes += 1
    let mine = changes
    Task {
      error = nil
      do {
        let saved = try await save(next)
        // A later change is on its way, and its answer has this one in it.
        if mine == changes { settings = saved }
      } catch {
        if mine == changes { settings = before }
        self.error = message(for: error)
      }
    }
  }

  private func load() async {
    await act {
      async let s = store.loadSettings()
      async let sp = store.loadSpend()
      (settings, spend) = try await (s, sp)
    }
  }

  private func act(_ work: () async throws -> Void) async {
    error = nil
    do { try await work() } catch { self.error = message(for: error) }
  }
}
