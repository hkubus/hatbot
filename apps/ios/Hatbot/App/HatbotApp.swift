// The app: sign-in until there's a token, then chat, with the other sections in a sidebar (PLAN.md §10.3).
// Notifications come from the ntfy app; hatbot:// links open tasks, approvals, schedules and triggers,
// and quick actions and Spotlight results open theirs (App/Extras.swift).
import CoreSpotlight
import SwiftUI
import WidgetKit

@main
struct HatbotApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var session: Session

  init() {
    let vault = KeychainVault()
    AppGroup.migrate(vault: vault)
    _session = State(initialValue: Session(vault: vault, defaults: AppGroup.defaults, cacheDir: AppGroup.cacheDir))
    PrivacyCover.shared.start()
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
      // Links in replies, sources and task steps: only the kinds that can't start anything else.
      .environment(\.openURL, OpenURLAction { url in AppLink.opens(url) ? .systemAction : .discarded })
      .tint(.brand)
      .onChange(of: session.store == nil) { _, out in
        if out {
          Spotlight.clear()
          AttachmentCache.shared.clear()
          ScreenCache.shared.clear()
          Task { await Badge.show(0) }
        }
      }
    }
  }
}

struct MainView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var phase
  @State private var tab = AppTab.chat
  @State private var sidebar = false
  @State private var chatPath: [Route] = []
  @State private var tasksPath: [Route] = []
  @State private var drafts = Drafts()
  /// A message to show in the chat, from Search.
  @State private var focus: Int?
  @State private var settingsPath: [Route] = []
  @State private var memoryPath: [Route] = []

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
    .onContinueUserActivity(CSSearchableItemActionType) { activity in
      if let url = Spotlight.link(activity) { open(url) }
    }
    .onChange(of: QuickActions.shared.url, initial: true) { _, url in
      guard let url else { return }
      QuickActions.shared.url = nil
      open(url)
    }
    // The count on the app icon, while the app's been open: there's no push to change it after.
    .task { await Badge.allow() }
    .onChange(of: store.needsYou, initial: true) { _, n in
      Task { await Badge.show(n) }
      WidgetCenter.shared.reloadTimelines(ofKind: WidgetKinds.status)
    }
    .onChange(of: store.paused) { ControlCenter.shared.reloadControls(ofKind: WidgetKinds.pause) }
    // What Spotlight finds, a little after launch.
    .task {
      try? await Task.sleep(for: .seconds(5))
      await Spotlight.index(store)
    }
    .overlay(alignment: .top) { Toast() }
    .environment(drafts)
    // Hatbot needs you: an approval came in, or the desktop asks for you.
    .sensoryFeedback(.warning, trigger: store.needsYou) { old, new in new > old }
  }

  @ViewBuilder
  private var section: some View {
    switch tab {
    case .chat: ChatView(path: $chatPath, focus: $focus)
    case .search:
      SearchView { conversationId, messageId in
        tab = .chat
        Task {
          if store.incognito { await store.setIncognito(false) }
          if store.conversations.contains(where: { $0.id == conversationId }) {
            await store.openConversation(conversationId)
          }
          focus = messageId
        }
      }
    case .tasks: TasksView(path: $tasksPath)
    case .live:
      NavigationStack {
        // While you have control, drags go to the desktop.
        ScrollView { LiveView(fullScreen: true) }
          .scrollDisabled(store.desktop?.control == .owner)
          .navigationTitle("Live")
          .navigationBarTitleDisplayMode(.inline)
          .sidebarButton()
          .routes()
      }
    case .memory: MemoryView(path: $memoryPath)
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
    case .newMessage:
      tab = .chat
      chatPath = []
    case .live:
      tab = .live
    case .tasks:
      tab = .tasks
      tasksPath = []
    case let .memory(path):
      tab = .memory
      memoryPath = [.memoryFile(path)]
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
