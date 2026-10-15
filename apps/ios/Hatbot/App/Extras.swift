// What the app does outside itself, with no push: home-screen quick actions, Spotlight results for
// memory, tasks and schedules, and the needs-you count on the app icon. Each opens a hatbot:// link.
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

enum Spotlight {
  private struct Entry: Sendable {
    var link: AppLink
    var domain: String
    var title: String
    var detail: String
  }

  /// Memory files by name, tasks by title and schedules by name, in place of what was indexed before.
  @MainActor
  static func index(_ store: AppStore) async {
    guard CSSearchableIndex.isIndexingAvailable() else { return }
    var entries: [Entry] = []
    if let files = try? await store.memoryTree() {
      for f in files {
        let name = ((f.path as NSString).lastPathComponent as NSString).deletingPathExtension
        entries.append(Entry(link: .memory(f.path), domain: "memory", title: name, detail: f.path))
      }
    }
    for filter in [AppStore.TaskFilter.active, .done] {
      for id in (try? await store.loadTasks(filter)) ?? [] {
        guard let t = store.tasks[id] else { continue }
        entries.append(Entry(link: .task(id), domain: "tasks", title: t.title, detail: "Task"))
      }
    }
    if (try? await store.loadSchedules()) != nil {
      for s in store.schedules.values {
        entries.append(Entry(link: .schedule(s.id), domain: "schedules", title: s.name, detail: s.prompt))
      }
    }
    await replace(entries)
  }

  private static func replace(_ entries: [Entry]) async {
    let index = CSSearchableIndex.default()
    try? await index.deleteAllSearchableItems()
    try? await index.indexSearchableItems(entries.map(item))
  }

  /// Signed out: nothing of Hatbot's stays searchable.
  static func clear() {
    CSSearchableIndex.default().deleteAllSearchableItems(completionHandler: nil)
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
