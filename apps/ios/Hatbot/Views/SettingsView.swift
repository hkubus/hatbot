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
  /// What's been changed here, shown until it's saved or put back.
  @State private var pending = AppStore.SettingsChange()
  /// Changes made here; a load from before one may not have it.
  @State private var changes = 0
  /// Changes still saving. A load meanwhile may not have them yet, so it leaves the settings alone.
  @State private var saving = 0

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
          if let current = settings?.weeklyReport {
            let report = setting(current, \.weeklyReport)
            Toggle("Weekly report", isOn: report.enabled)
            if report.wrappedValue.enabled {
              Picker("Day", selection: report.weekday) {
                ForEach(0..<7, id: \.self) { d in Text(Calendar.current.weekdaySymbols[d]).tag(d) }
              }
              Picker("Time", selection: report.hour) {
                ForEach(0..<24, id: \.self) { h in Text(String(format: "%02d:00", h)).tag(h) }
              }
            }
            Button("Send the report now") {
              Task {
                await attempt($error) {
                  _ = try await store.sendReport()
                  store.toast = "Sent to the chat"
                }
              }
            }
          }
          if let tidy = settings?.memoryTidy {
            Toggle("Propose a memory tidy-up weekly", isOn: setting(tidy, \.memoryTidy))
          }
        }
        if let settings {
          Section("Chat") {
            if let model = settings.chatModel {
              Picker("Model", selection: setting(model, \.chatModel)) {
                ForEach(AppSettings.ModelID.known.including(model), id: \.self) { m in
                  Text(m == .haiku ? "\(m.name), asks Opus for hard parts" : m.name).tag(m)
                }
              }
            }
            Picker("Effort", selection: setting(settings.chatEffort, \.chatEffort)) {
              ForEach(AppSettings.Effort.known.including(settings.chatEffort), id: \.self) { e in
                Text(e.name).tag(e)
              }
            }
          }
          if let model = settings.taskModel {
            Section("Tasks") {
              Picker("Model for background tasks", selection: setting(model, \.taskModel)) {
                ForEach(AppSettings.ModelID.known.including(model), id: \.self) { m in Text(m.name).tag(m) }
              }
            }
          }
          if let model = settings.desktopModel {
            let desktop = setting(model, \.desktopModel)
            Section("Desktop") {
              Picker("Model for desktop tasks", selection: desktop) {
                ForEach(AppSettings.ModelID.known.including(model), id: \.self) { m in Text(m.name).tag(m) }
              }
              if desktop.wrappedValue == .haiku, let escalate = settings.desktopEscalate {
                Toggle("Try again on Opus when Haiku fails", isOn: setting(escalate, \.desktopEscalate))
              }
            }
          }
          // Brains from before the setting don't have it.
          if let opens = settings.notificationsOpen {
            Section {
              Picker("Tapping one opens", selection: setting(opens, \.notificationsOpen)) {
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
            Toggle("Let Haiku allow safe changes", isOn: setting(review, \.reviewChanges))
          }
          if store.paused {
            Button("Resume") { Task { await attempt($error) { try await store.setPaused(false) } } }
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
        Button("Pause all", role: .destructive) { Task { await attempt($error) { try await store.setPaused(true) } } }
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
  private func setting<V: Equatable>(_ current: V, _ key: WritableKeyPath<AppStore.SettingsChange, V?>) -> Binding<V> {
    .saving(current, shown: $pending[dynamicMember: key]) { value in
      var change = AppStore.SettingsChange()
      change[keyPath: key] = value
      changes += 1
      saving += 1
      // Each answer is shown; a change still saving shows over it.
      await attempt($error) { settings = try await store.saveSettings(change) }
      saving -= 1
    }
  }

  private func load() async {
    let seen = changes
    await attempt($error) {
      async let s = store.loadSettings()
      async let sp = store.loadSpend()
      let (loaded, summary) = try await (s, sp)
      spend = summary
      // Each change's own answer brings the settings: this one may be from before it.
      if seen == changes && saving == 0 { settings = loaded }
    }
  }
}
