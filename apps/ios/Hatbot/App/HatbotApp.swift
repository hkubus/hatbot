import CoreSpotlight
import LocalAuthentication
import SwiftUI
import UIKit
import WidgetKit

@main
struct HatbotApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var session: Session
  @Environment(\.scenePhase) private var phase

  init() {
    let vault = KeychainVault()
    AppGroup.migrate(vault: vault)
    _session = State(
      initialValue: Session(
        vault: vault, signedOut: KeychainVault(account: "signed-out", accessGroup: nil), defaults: AppGroup.defaults,
        cacheDir: AppGroup.cacheDir))
    #if !targetEnvironment(macCatalyst)
      // A Mac has no app switcher, and its window stops being active whenever you click another app.
      PrivacyCover.shared.start()
    #endif
    Typeface.applyToUIKit()
  }

  var body: some Scene {
    WindowGroup {
      Group {
        if let store = session.store, let setup = session.setup {
          SetupView(store: store, setup: setup)
        } else if let store = session.store {
          MainView().environment(store)
        } else {
          LoginView()
        }
      }
      .environment(session)
      #if targetEnvironment(macCatalyst)
        // Material's switches, as on the web, where a Mac's would be checkboxes.
        .toggleStyle(.switch)
        .safeAreaInset(edge: .top, spacing: 0) { MacAgentBanner() }
        // The agent runs as whoever is signed in.
        .onChange(of: session.store?.api.token, initial: true) {
          MacAgent.shared.run(server: session.store?.api.server, token: session.store?.api.token)
        }
      #endif
      .font(.sans())
      // Links in replies, sources and task steps: only the kinds that can't start anything else.
      .environment(\.openURL, OpenURLAction { url in AppLink.tapped(url).map { .systemAction($0) } ?? .discarded })
      // Back from the web app, perhaps with the setup finished.
      .onChange(of: phase, initial: true) { _, phase in
        if phase == .active { Task { await session.checkSetup() } }
      }
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
    #if targetEnvironment(macCatalyst)
      .commands { MacMenus() }
    #endif
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
  /// A notification's Approve, waiting for you to say yes to what it is.
  @State private var confirming: Approval?
  @State private var searchAsked = 0

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
    .alert(
      "Approve this?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      presenting: confirming
    ) { a in
      Button("Approve") { approve(a) }
      Button("Cancel", role: .cancel) {}
    } message: { a in
      Text(a.summary)
    }
    .environment(drafts)
    #if targetEnvironment(macCatalyst)
      .focusedSceneValue(
        \.menuActions,
        MenuActions(show: show, newMessage: { open(AppLink.newMessage.url) }, moveChat: moveChat))
    #endif
    .sensoryFeedback(.warning, trigger: store.needsYou) { old, new in new > old }
  }

  private var sections: some View {
    ZStack {
      ForEach(AppTab.allCases.filter { opened.contains($0) || $0 == tab }, id: \.self) { t in
        section(t)
          .offWithItsPlugin(t)
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
      SearchView(asked: searchAsked) { conversationId, messageId in
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

  private func show(_ section: AppTab) {
    tab = section
    if section == .search { searchAsked += 1 }
  }

  /// To the chat above or below in the sidebar, as Option-Up and Option-Down do on the web.
  private func moveChat(_ by: Int) {
    let chats = store.conversations
    guard let i = chats.firstIndex(where: { $0.id == store.listedChatId }), chats.indices.contains(i + by) else {
      return
    }
    tab = .chat
    Task { await store.openConversation(chats[i + by].id) }
  }

  /// Opens the approval's task, or the negotiation it's about; `approving`, a notification's Approve, asks to
  /// approve it, then approves it once Face ID (or the passcode) says it's you.
  private func openApproval(_ id: Int, approving: Bool) {
    tab = .tasks
    tasksPath = []
    Task {
      let approval: Approval? = try? await store.api.get("/approvals/\(id)")
      guard let a = approval else { return }
      store.apply(.approvalCreated(a))
      if let taskId = a.taskId {
        tasksPath = [.task(taskId)]
      } else if let n = await store.findNegotiation(for: a) {
        tasksPath = [.negotiation(n.id)]
      }
      // Asked first, with what it is: any app or page can open this link, and Face ID doesn't say what it's for.
      // A secret is typed in where it shows, not approved from here.
      if approving && a.status == .pending && a.secret == nil { confirming = a }
    }
  }

  private func approve(_ a: Approval) {
    Task {
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

  private func openAutomation(_ route: Route) {
    tab = .settings
    if store.pluginOn("automation") {
      settingsPath = [.schedules, route]
    } else {
      settingsPath = []
      store.toast = "\(store.plugins["automation"]?.name ?? "Automation") is off."
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
      openAutomation(.schedule(id))
    case let .trigger(id):
      openAutomation(.trigger(id))
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
        .font(.sans(.footnote))
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
