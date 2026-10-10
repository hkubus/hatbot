// The app: sign-in until there's a token, then tabs like the web app on a phone (PLAN.md §10.3).
// Notifications come from the ntfy app; a hatbot://tasks/<id> link opens a task.
import SwiftUI

@main
struct HatbotApp: App {
  @State private var session = Session(vault: KeychainVault())

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

enum AppTab: Hashable {
  case chat, tasks, live, settings
}

struct MainView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var tab = AppTab.chat
  @State private var tasksPath: [Route] = []

  var body: some View {
    TabView(selection: $tab) {
      Tab("Chat", systemImage: "bubble.left.and.bubble.right", value: .chat) {
        ChatView()
      }
      Tab("Tasks", systemImage: "checklist", value: .tasks) {
        TasksView(path: $tasksPath)
      }
      .badge(store.needsYou)
      Tab("Live", systemImage: "display", value: .live) {
        NavigationStack {
          // While you have control, drags go to the desktop.
          ScrollView { LiveView() }
            .scrollDisabled(store.desktop?.control == .owner)
            .navigationTitle("Live")
            .navigationBarTitleDisplayMode(.inline)
            .routes()
        }
      }
      Tab("Settings", systemImage: "gearshape", value: .settings) {
        SettingsView()
      }
    }
    .minimizingTabBar()
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

  /// hatbot://tasks/12 opens a task; hatbot://approvals/5 opens the approval's task.
  private func open(_ url: URL) {
    guard url.scheme == "hatbot", let id = Int(url.lastPathComponent) else { return }
    switch url.host() {
    case "tasks":
      tab = .tasks
      tasksPath = [.task(id)]
    case "approvals":
      tab = .tasks
      tasksPath = []
      Task {
        let approval: Approval? = try? await store.api.get("/approvals/\(id)")
        if let a = approval {
          store.apply(.approvalCreated(a))
          if let taskId = a.taskId { tasksPath = [.task(taskId)] }
        }
      }
    default:
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
