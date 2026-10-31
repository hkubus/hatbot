import CoreSpotlight
import LocalAuthentication
import SwiftUI
import UIKit
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
      .onChange(of: session.store == nil) { _, out in
        // The widget reads the brain as you, or says to sign in.
        WidgetCenter.shared.reloadAllTimelines()
        ControlCenter.shared.reloadAllControls()
        if out {
          Spotlight.clear()
          ImageCache.attachments.clear()
          ImageCache.screens.clear()
          ChartFile.clear()
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
  /// The sections opened so far. Each is kept, hidden while another shows, so an edit you were making
  /// or a secret you were shown is still there when you come back.
  @State private var opened: Set<AppTab> = [.chat]
  /// How many of each section's first page show: none while a page is pushed over it.
  @State private var roots: [AppTab: Int] = [:]
  @State private var sidebar = false
  @State private var chatPath: [Route] = []
  @State private var tasksPath: [Route] = []
  @State private var drafts = Drafts()
  @State private var focus: Int?
  @State private var settingsPath: [Route] = []
  @State private var memoryPath: [Route] = []
  @State private var todoPath: [Route] = []
  @State private var boxesPath: [Route] = []
  @State private var lingering = Lingering()

  var body: some View {
    Sidebar(tab: $tab, open: $sidebar, atRoot: roots[tab, default: 0] > 0) { sections }
    .onChange(of: tab) { _, t in
      opened.insert(t)
      // A field in the section you left mustn't keep the keyboard up over this one.
      hideKeyboard()
    }
    // The event stream runs while the app is in front, and for the half minute or so iOS gives it to finish
    // up in the background: back by then, there's nothing to reconnect.
    .onChange(of: phase, initial: true) { _, phase in
      if phase == .active {
        lingering.end()
        store.connect()
      } else if phase == .background {
        store.persist()
        lingering.begin { store.disconnect() }
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
    .task {
      try? await Task.sleep(for: .seconds(5))
      await Spotlight.index(store)
    }
    .overlay(alignment: .top) { Toast() }
    .environment(drafts)
    .sensoryFeedback(.warning, trigger: store.needsYou) { old, new in new > old }
  }

  private var sections: some View {
    ZStack {
      ForEach(AppTab.allCases.filter { opened.contains($0) || $0 == tab }, id: \.self) { t in
        section(t)
          .environment(\.sidebarRoot) { shown in roots[t] = max(0, roots[t, default: 0] + (shown ? 1 : -1)) }
          .environment(\.sectionShown, t == tab)
          .opacity(t == tab ? 1 : 0)
          .allowsHitTesting(t == tab)
          .accessibilityHidden(t != tab)
      }
    }
  }

  @ViewBuilder
  private func section(_ which: AppTab) -> some View {
    switch which {
    case .chat: ChatView(path: $chatPath, focus: $focus)
    case .search:
      SearchView { conversationId, messageId in
        tab = .chat
        Task {
          if store.incognito { await store.setIncognito(false) }
          // One that didn't load says so; the message isn't looked for in what was kept.
          // One the chat list doesn't have is a thread.
          let opened: Bool
          if store.conversations.contains(where: { $0.id == conversationId }) {
            opened = await store.openConversation(conversationId)
          } else if conversationId == store.conversationId {
            opened = true
          } else {
            opened = await store.openThread(conversationId)
          }
          if !opened { return }
          focus = messageId
        }
      }
    case .tasks: TasksView(path: $tasksPath)
    case .todo: TodoView(path: $todoPath)
    case .boxes: BoxesView(path: $boxesPath)
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

  /// Opens the approval's task; `approving`, a notification's Approve, approves it once Face ID (or
  /// the passcode) says it's you.
  private func openApproval(_ id: Int, approving: Bool) {
    tab = .tasks
    tasksPath = []
    Task {
      let approval: Approval? = try? await store.api.get("/approvals/\(id)")
      guard let a = approval else { return }
      store.apply(.approvalCreated(a))
      if let taskId = a.taskId { tasksPath = [.task(taskId)] }
      guard approving, a.status == .pending else { return }
      let context = LAContext()
      guard (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Approve: \(a.summary)")) == true
      else { return }
      do {
        try await store.decide(a.id, .approve)
        store.toast = "Approved"
      } catch {
        store.toast = message(for: error)
      }
    }
  }

  /// hatbot://tasks/12 opens a task, hatbot://approvals/5 the approval's task; schedules and triggers
  /// open under Settings, like on the web app on a phone, and hatbot://boxes/4 a box under Boxes.
  private func open(_ url: URL) {
    sidebar = false
    switch AppLink(url: url) {
    case let .task(id):
      tab = .tasks
      tasksPath = [.task(id)]
    case let .approval(id):
      openApproval(id, approving: false)
    case let .approve(id):
      openApproval(id, approving: true)
    case let .schedule(id):
      tab = .settings
      settingsPath = [.schedules, .schedule(id)]
    case let .trigger(id):
      tab = .settings
      settingsPath = [.schedules, .trigger(id)]
    case let .box(id):
      tab = .boxes
      boxesPath = [.box(id)]
    case .newMessage:
      tab = .chat
      chatPath = []
    case let .thread(id):
      tab = .chat
      chatPath = []
      Task {
        if store.incognito { await store.setIncognito(false) }
        await store.openThread(id)
      }
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
        .task(id: store.toastId) {
          // A newer note, or the same one again, ends this wait early; that one then gets its own 2.8 s.
          let id = store.toastId
          do { try await Task.sleep(for: .seconds(2.8)) } catch { return }
          if store.toastId == id { withAnimation { store.toast = nil } }
        }
    }
  }
}

@MainActor
final class Lingering {
  private var task = UIBackgroundTaskIdentifier.invalid

  /// `then` runs when that time is up, or at once when there's none.
  func begin(then: @escaping @MainActor @Sendable () -> Void) {
    end()
    // Held until then, so the time is handed back even if the view that began it has gone.
    task = UIApplication.shared.beginBackgroundTask(withName: "Event stream") {
      then()
      self.end()
    }
    if task == .invalid { then() }
  }

  func end() {
    guard task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
  }
}
