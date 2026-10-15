// The app: sign-in until there's a token, then chat, with the other sections in a sidebar (PLAN.md §10.3).
// Notifications come from the ntfy app; hatbot:// links open tasks, approvals, schedules and triggers.
import SwiftUI

@main
struct HatbotApp: App {
  @State private var session: Session

  init() {
    let vault = KeychainVault()
    AppGroup.migrate(vault: vault)
    _session = State(initialValue: Session(vault: vault, defaults: AppGroup.defaults))
  }

  var body: some Scene {
    WindowGroup {
      Group {
        if let store = session.store {
          MainView().environment(store)
        } else {
          LoginView()
        }
      }
      .environment(session)
      .tint(.brand)
    }
  }
}

struct MainView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var tab = AppTab.chat
  @State private var sidebar = false
  @State private var tasksPath: [Route] = []
  @State private var settingsPath: [Route] = []

  var body: some View {
    Sidebar(tab: $tab, open: $sidebar) { section }
    // The event stream runs while the app is in front; iOS would cut it in the background anyway.
    .onChange(of: phase, initial: true) { _, phase in
      if phase == .active {
        store.connect()
      } else if phase == .background {
        store.disconnect()
      }
    }
    .onOpenURL(perform: open)
    .overlay(alignment: .top) { Toast() }
  }

  @ViewBuilder
  private var section: some View {
    switch tab {
    case .chat: ChatView()
    case .search:
      SearchView { id in
        tab = .chat
        if store.conversations.contains(where: { $0.id == id }) {
          Task { await store.openConversation(id) }
        }
      }
    case .tasks: TasksView(path: $tasksPath)
    case .live:
      NavigationStack {
        // While you have control, drags go to the desktop.
        ScrollView { LiveView() }
          .scrollDisabled(store.desktop?.control == .owner)
          .navigationTitle("Live")
          .navigationBarTitleDisplayMode(.inline)
          .sidebarButton()
          .routes()
      }
    case .memory: MemoryView()
    case .settings: SettingsView(path: $settingsPath)
    }
  }

  /// hatbot://tasks/12 opens a task, hatbot://approvals/5 the approval's task; schedules and triggers
  /// open under Settings, like on the web app on a phone.
  private func open(_ url: URL) {
    sidebar = false
    switch AppLink(url: url) {
    case let .task(id):
      tab = .tasks
      tasksPath = [.task(id)]
    case let .approval(id):
      tab = .tasks
      tasksPath = []
      Task {
        let approval: Approval? = try? await store.api.get("/approvals/\(id)")
        if let a = approval {
          store.apply(.approvalCreated(a))
          if let taskId = a.taskId { tasksPath = [.task(taskId)] }
        }
      }
    case let .schedule(id):
      tab = .settings
      settingsPath = [.schedules, .schedule(id)]
    case let .trigger(id):
      tab = .settings
      settingsPath = [.schedules, .trigger(id)]
    case nil:
      break
    }
  }
}

/// A short note, like "Memory: …", that fades after a moment.
private struct Toast: View {
  @Environment(AppStore.self) private var store

  var body: some View {
    if let text = store.toast {
      Text(text)
        .font(.footnote)
        .lineLimit(2)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassSurface(in: .capsule)
        .padding(.top, 4)
        .transition(.move(edge: .top).combined(with: .opacity))
        .task(id: text) {
          try? await Task.sleep(for: .seconds(2.8))
          withAnimation { store.toast = nil }
        }
    }
  }
}
