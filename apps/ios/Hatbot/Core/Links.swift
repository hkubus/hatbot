// hatbot:// links, which notifications open when Settings → Notifications says the app.
import Foundation

enum AppLink: Equatable, Sendable {
  case task(Int)
  case approval(Int)
  case schedule(Int)
  case trigger(Int)

  /// hatbot://tasks/12, hatbot://approvals/5, hatbot://schedules/2, hatbot://triggers/3.
  init?(url: URL) {
    guard url.scheme == "hatbot", let id = Int(url.lastPathComponent), url.pathComponents.count == 2 else {
      return nil
    }
    switch url.host() {
    case "tasks": self = .task(id)
    case "approvals": self = .approval(id)
    case "schedules": self = .schedule(id)
    case "triggers": self = .trigger(id)
    default: return nil
    }
  }
}
