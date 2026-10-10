// Settings: spend against the limits, Schedules & Triggers, chat effort, what notifications open,
// Pause all (PLAN.md §6.5), and signing out.
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
        }
        Section {
          NavigationLink("Schedules & Triggers", value: Route.schedules)
        }
        if let settings {
          Section("Chat") {
            if let model = settings.chatModel {
              Picker("Model", selection: chatModel(model)) {
                Text("Haiku 5.5, asks Opus for hard parts").tag(AppSettings.ChatModel.haiku)
                Text("Opus 5.5").tag(AppSettings.ChatModel.opus)
              }
            }
            Picker("Effort", selection: effort(settings)) {
              Text("Low").tag(AppSettings.Effort.low)
              Text("Medium").tag(AppSettings.Effort.medium)
            }
          }
          if let model = settings.desktopModel {
            Section("Desktop") {
              Picker("Model for desktop tasks", selection: desktopModel(model)) {
                Text("Opus 5.5").tag(AppSettings.DesktopModel.opus)
                Text("Haiku 5.5 (cheaper, less tested)").tag(AppSettings.DesktopModel.haiku)
              }
            }
          }
          // Brains from before the setting don't have it.
          if let opens = settings.notificationsOpen {
            Section {
              Picker("Tapping one opens", selection: notificationsOpen(opens)) {
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
          if let skip = settings?.skipAskedApprovals {
            Toggle(
              "Don't ask again for what I asked for",
              isOn: Binding(
                get: { skip },
                set: { on in Task { await act { settings = try await store.setSkipAskedApprovals(on) } } }))
          }
          if store.paused {
            Button("Resume") { Task { await act { try await store.setPaused(false) } } }
          } else {
            Button("Pause all", role: .destructive) { confirmPause = true }
          }
        }
        Section {
          LabeledContent("Server", value: store.api.server.host() ?? store.api.server.absoluteString)
          Button("Sign out", role: .destructive) { confirmSignOut = true }
        }
      }
      .navigationTitle("Settings")
      .confirmationDialog("Pause all?", isPresented: $confirmPause, titleVisibility: .visible) {
        Button("Pause all", role: .destructive) { Task { await act { try await store.setPaused(true) } } }
      }
      .confirmationDialog("Sign out of Hatbot?", isPresented: $confirmSignOut, titleVisibility: .visible) {
        Button("Sign out", role: .destructive) { Task { await session.signOut() } }
      }
      .task { await load() }
      .refreshable { await load() }
      .routes()
    }
  }

  private func spendText(_ usd: Double?, limit: Double?) -> String {
    guard let usd else { return "–" }
    guard let limit else { return Format.money(usd) }
    return "\(Format.money(usd)) of \(Format.money(limit))"
  }

  private func effort(_ current: AppSettings) -> Binding<AppSettings.Effort> {
    Binding(
      get: { current.chatEffort },
      set: { value in
        Task { await act { settings = try await store.setChatEffort(value) } }
      })
  }

  private func chatModel(_ current: AppSettings.ChatModel) -> Binding<AppSettings.ChatModel> {
    Binding(
      get: { current },
      set: { value in
        Task { await act { settings = try await store.setChatModel(value) } }
      })
  }

  private func desktopModel(_ current: AppSettings.DesktopModel) -> Binding<AppSettings.DesktopModel> {
    Binding(
      get: { current },
      set: { value in
        Task { await act { settings = try await store.setDesktopModel(value) } }
      })
  }

  private func notificationsOpen(_ current: AppSettings.Opens) -> Binding<AppSettings.Opens> {
    Binding(
      get: { current },
      set: { value in
        Task { await act { settings = try await store.setNotificationsOpen(value) } }
      })
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
