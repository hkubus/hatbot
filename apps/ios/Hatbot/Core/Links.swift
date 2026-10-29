import Foundation

enum AppLink: Equatable, Sendable {
  case task(Int)
  case approval(Int)
  /// A notification's Approve, for what only the app approves: it asks for Face ID first.
  case approve(Int)
  case schedule(Int)
  case trigger(Int)
  case box(Int)
  case newMessage
  case live
  case tasks
  case memory(String)

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
      case "approvals":
        let approve = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
          .contains { $0.name == "approve" && $0.value == "1" } ?? false
        self = approve ? .approve(id) : .approval(id)
      case "schedules": self = .schedule(id)
      case "triggers": self = .trigger(id)
      case "boxes": self = .box(id)
      default: return nil
      }
    default: return nil
    }
  }

  /// A reply that quotes a page can carry a shortcuts:, tel: or other app's link, which mustn't run on a tap.
  static func opens(_ url: URL) -> Bool {
    ["http", "https", "mailto", "hatbot"].contains(url.scheme?.lowercased() ?? "")
  }

  var url: URL {
    let s =
      switch self {
      case let .task(id): "tasks/\(id)"
      case let .approval(id): "approvals/\(id)"
      case let .approve(id): "approvals/\(id)?approve=1"
      case let .schedule(id): "schedules/\(id)"
      case let .trigger(id): "triggers/\(id)"
      case let .box(id): "boxes/\(id)"
      case .newMessage: "new"
      case .live: "live"
      case .tasks: "tasks"
      case let .memory(path): "memory/" + (path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path)
      }
    return URL(string: "hatbot://\(s)")!
  }
}
