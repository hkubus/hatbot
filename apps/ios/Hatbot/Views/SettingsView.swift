import SwiftUI

struct SettingsView: View {
  @Binding var path: [Route]
  @Environment(Session.self) private var session
  @Environment(AppStore.self) private var store
  @State private var settings: AppSettings?
  @State private var models: [ModelOption] = []
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
        Section {
          Toggle(
            "Pause all activity",
            isOn: Binding(
              get: { store.paused },
              set: { on in Task { await attempt($error) { try await store.setPaused(on) } } }))
        }
        Section {
          NavigationLink("Automations", value: Route.schedules)
          NavigationLink("Spend", value: Route.spend)
        }
        if let settings {
          Section("Models") {
            let expert = settings.expertModel ?? .opus
            if let model = settings.chatModel {
              Picker("Chat", selection: setting(model, \.chatModel)) {
                ForEach(models.choices(model), id: \.self) { m in
                  Text(m == expert ? models.name(m) : "\(models.name(m)), asks \(models.name(expert)) for hard parts").tag(m)
                }
              }
            }
            Picker("Chat effort", selection: setting(settings.chatEffort, \.chatEffort)) {
              ForEach(AppSettings.Effort.known.including(settings.chatEffort), id: \.self) { e in
                Text(e.name).tag(e)
              }
            }
            if let model = settings.taskModel {
              Picker("Background tasks", selection: setting(model, \.taskModel)) {
                ForEach(models.choices(model), id: \.self) { m in Text(models.name(m)).tag(m) }
              }
            }
            if let model = settings.desktopModel {
              let desktop = setting(model, \.desktopModel)
              Picker("Desktop tasks", selection: desktop) {
                ForEach(models.choices(model, only: \.computerUse), id: \.self) { m in Text(models.name(m)).tag(m) }
              }
              if desktop.wrappedValue != expert, let escalate = settings.desktopEscalate {
                Toggle(
                  "Try desktop tasks again on \(models.name(expert)) when they fail",
                  isOn: setting(escalate, \.desktopEscalate))
              }
            }
            if let model = settings.smallModel {
              Picker("Quick jobs", selection: setting(model, \.smallModel)) {
                ForEach(models.choices(model), id: \.self) { m in Text(models.name(m)).tag(m) }
              }
            }
            if let model = settings.expertModel {
              Picker("Hard parts", selection: setting(model, \.expertModel)) {
                ForEach(models.choices(model), id: \.self) { m in Text(models.name(m)).tag(m) }
              }
            }
          }
        }
        Section("Spending") {
          NavigationLink("Limits", value: Route.limits)
        }
        Section {
          // Brains from before the setting don't have it.
          if let opens = settings?.notificationsOpen {
            Picker("Tapping one opens", selection: setting(opens, \.notificationsOpen)) {
              Text("The web app").tag(AppSettings.Opens.web)
              Text("This app").tag(AppSettings.Opens.app)
            }
          }
          TestApprovalRow()
        } header: {
          Text("Notifications")
        } footer: {
          Text("Notifications come from the ntfy app.")
        }
        if let review = settings?.reviewChanges {
          Section("Safety") {
            Toggle("Let a safety review allow safe changes without asking you", isOn: setting(review, \.reviewChanges))
          }
        }
        Section("Account") {
          LabeledContent("Server", value: store.api.server.host() ?? store.api.server.absoluteString)
          NavigationLink("Devices and tokens", value: Route.devices)
          Button("Sign out", role: .destructive) { confirmSignOut = true }
        }
        Section("System") {
          NavigationLink("Check everything", value: Route.checks)
        }
      }
      .navigationTitle("Settings")
      .sidebarButton()
      .confirmationDialog("Sign out of Hatbot?", isPresented: $confirmSignOut, titleVisibility: .visible) {
        Button("Sign out", role: .destructive) { Task { await session.signOut() } }
      }
      .task { await load() }
      .refreshable { await load() }
      .onChange(of: store.settingsVersion) { Task { await load() } }
      .routes()
    }
  }

  /// A setting's control. A change shows at once, as the switch or picker moved, and is saved behind it;
  /// if saving fails, it goes back and says why.
  private func setting<V: Equatable & Sendable>(_ current: V, _ key: WritableKeyPath<AppStore.SettingsChange, V?>) -> Binding<V> {
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
    models = await store.loadModels()
    await attempt($error) {
      let loaded = try await store.loadSettings()
      // Each change's own answer brings the settings: this one may be from before it.
      if seen == changes && saving == 0 { settings = loaded }
    }
  }
}
