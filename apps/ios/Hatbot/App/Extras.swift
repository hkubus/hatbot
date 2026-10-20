// What the app does outside itself, with no push: home-screen quick actions, Spotlight results for
// memory, tasks and schedules, and the needs-you count on the app icon. Each opens a hatbot:// link.
// And what the app switcher shows of it: nothing.
import CoreSpotlight
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import UserNotifications

/// A quick action picked on the home screen, for MainView to open. Its type is its hatbot:// link
/// (project.yml, UIApplicationShortcutItems).
@MainActor
@Observable
final class QuickActions {
  static let shared = QuickActions()
  var url: URL?

  func pick(_ item: UIApplicationShortcutItem) {
    url = URL(string: item.type)
  }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    // Launched by a quick action.
    if let item = options.shortcutItem { QuickActions.shared.pick(item) }
    let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    config.delegateClass = SceneDelegate.self
    return config
  }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
  /// A quick action while the app was running.
  func windowScene(
    _ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    QuickActions.shared.pick(shortcutItem)
    completionHandler(true)
  }
}

/// Covers the app while it isn't active, so the app switcher's picture of it shows no secrets, desktop or
/// approvals. A window of its own, over sheets too.
@MainActor
final class PrivacyCover {
  static let shared = PrivacyCover()
  private var windows: [ObjectIdentifier: UIWindow] = [:]

  func start() {
    let center = NotificationCenter.default
    center.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { note in
      guard let scene = note.object as? UIWindowScene else { return }
      MainActor.assumeIsolated { PrivacyCover.shared.cover(scene) }
    }
    center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { note in
      guard let scene = note.object as? UIWindowScene else { return }
      MainActor.assumeIsolated { PrivacyCover.shared.uncover(scene) }
    }
  }

  private func cover(_ scene: UIWindowScene) {
    let id = ObjectIdentifier(scene)
    if windows[id] != nil { return }
    let window = UIWindow(windowScene: scene)
    let blank = UIViewController()
    blank.view.backgroundColor = .systemBackground
    window.rootViewController = blank
    window.windowLevel = .alert + 1
    window.isHidden = false
    windows[id] = window
  }

  private func uncover(_ scene: UIWindowScene) {
    windows.removeValue(forKey: ObjectIdentifier(scene))?.isHidden = true
  }
}

enum Spotlight {
  private struct Entry: Sendable {
    var link: AppLink
    var domain: String
    var title: String
    var detail: String
  }

  /// Hatbot's own index, readable only while the phone is unlocked.
  nonisolated(unsafe) private static let searchIndex = CSSearchableIndex(name: "Hatbot", protectionClass: .complete)

  /// Memory files, tasks and schedules by name only, in place of what was indexed before.
  @MainActor
  static func index(_ store: AppStore) async {
    guard CSSearchableIndex.isIndexingAvailable() else { return }
    var entries: [Entry] = []
    // Memory's, if it has loaded them already.
    var files = store.memoryFilesLoaded ? store.memoryFiles : nil
    if files == nil { files = try? await store.memoryTree() }
    for f in files ?? [] {
      let name = ((f.path as NSString).lastPathComponent as NSString).deletingPathExtension
      entries.append(Entry(link: .memory(f.path), domain: "memory", title: name, detail: f.path))
    }
    for filter in [AppStore.TaskFilter.active, .done] {
      for id in (try? await store.loadTasks(filter)) ?? [] {
        guard let t = store.tasks[id] else { continue }
        entries.append(Entry(link: .task(id), domain: "tasks", title: t.title, detail: "Task"))
      }
    }
    if (try? await store.loadSchedules()) != nil {
      for s in store.schedules.values {
        entries.append(Entry(link: .schedule(s.id), domain: "schedules", title: s.name, detail: "Schedule"))
      }
    }
    // Signing out cancels this, and clears the index: what was gathered mustn't go back in.
    guard !Task.isCancelled else { return }
    await replace(entries)
  }

  private static func replace(_ entries: [Entry]) async {
    // What older versions put in the default index, with schedules' prompts and its weaker protection.
    try? await CSSearchableIndex.default().deleteAllSearchableItems()
    try? await searchIndex.deleteAllSearchableItems()
    guard !Task.isCancelled else { return }
    try? await searchIndex.indexSearchableItems(entries.map(item))
  }

  /// Signed out: nothing of Hatbot's stays searchable.
  static func clear() {
    CSSearchableIndex.default().deleteAllSearchableItems(completionHandler: nil)
    searchIndex.deleteAllSearchableItems(completionHandler: nil)
  }

  /// The link of a Spotlight result that opened the app.
  static func link(_ activity: NSUserActivity) -> URL? {
    (activity.userInfo?[CSSearchableItemActivityIdentifier] as? String).flatMap(URL.init(string:))
  }

  private static func item(_ e: Entry) -> CSSearchableItem {
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = e.title
    attributes.contentDescription = e.detail
    return CSSearchableItem(
      uniqueIdentifier: e.link.url.absoluteString, domainIdentifier: e.domain, attributeSet: attributes)
  }
}

enum Badge {
  /// Only the badge: notifications come from ntfy.
  static func allow() async {
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.badge])
  }

  static func show(_ count: Int) async {
    try? await UNUserNotificationCenter.current().setBadgeCount(count)
  }
}
