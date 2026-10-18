// hatbot:// links, which notifications open when Settings → Notifications says the app, and which the
// home-screen quick actions and Spotlight results open.
import Foundation

enum AppLink: Equatable, Sendable {
  case task(Int)
  case approval(Int)
  case schedule(Int)
  case trigger(Int)
  /// The chat, to write in.
  case newMessage
  case live
  case tasks
  case memory(String)

  /// hatbot://tasks/12, hatbot://approvals/5, hatbot://schedules/2, hatbot://triggers/3; hatbot://new,
  /// hatbot://live, hatbot://tasks; hatbot://memory/notes/servers.md.
  init?(url: URL) {
    guard url.scheme?.lowercased() == "hatbot", let host = url.host() else { return nil }
    let parts = url.pathComponents.filter { $0 != "/" }
    switch (host, parts.count) {
    case ("new", 0): self = .newMessage
    case ("live", 0): self = .live
    case ("tasks", 0): self = .tasks
    case ("memory", 1...): self = .memory(parts.joined(separator: "/"))
    case (_, 1):
      guard let id = Int(parts[0]) else { return nil }
      switch host {
      case "tasks": self = .task(id)
      case "approvals": self = .approval(id)
      case "schedules": self = .schedule(id)
      case "triggers": self = .trigger(id)
      default: return nil
      }
    default: return nil
    }
  }

  /// Whether a tapped link may open: web pages, mail and the app's own links. A reply that quotes a page
  /// can carry a shortcuts:, tel: or other app's link, which mustn't run on a tap.
  static func opens(_ url: URL) -> Bool {
    ["http", "https", "mailto", "hatbot"].contains(url.scheme?.lowercased() ?? "")
  }

  var url: URL {
    let s =
      switch self {
      case let .task(id): "tasks/\(id)"
      case let .approval(id): "approvals/\(id)"
      case let .schedule(id): "schedules/\(id)"
      case let .trigger(id): "triggers/\(id)"
      case .newMessage: "new"
      case .live: "live"
      case .tasks: "tasks"
      case let .memory(path): "memory/" + (path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)
      }
    return URL(string: "hatbot://\(s)")!
  }
}
