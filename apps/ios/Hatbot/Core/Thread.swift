// The chat in folds (threadGroups in packages/shared): each finished conversation folds up under its recap.
import Foundation

struct ThreadGroup: Identifiable, Equatable, Sendable {
  var episodeId: Int?
  var messages: [ThreadMessage]
  /// What the fold says, for a finished conversation; nil when it stays open.
  var fold: String?

  var id: Int { messages[0].id }
}

enum ThreadFolds {
  private static let maxFallback = 120

  /// Messages in runs by conversation. Cards from background tasks join the conversation before them.
  /// Every conversation but the last folds; one without a recap shows its first message instead.
  static func groups(_ messages: [ThreadMessage], episodes: [Int: Episode]) -> [ThreadGroup] {
    var groups: [ThreadGroup] = []
    for m in messages {
      let key = m.episodeId ?? groups.last?.episodeId
      if !groups.isEmpty, groups[groups.count - 1].episodeId == key {
        groups[groups.count - 1].messages.append(m)
      } else {
        groups.append(ThreadGroup(episodeId: key, messages: [m]))
      }
    }
    for i in groups.indices where i < groups.count - 1 {
      guard let id = groups[i].episodeId else { continue }
      let first = groups[i].messages.first { $0.role == .user && $0.kind != .command }?.text
        .split(whereSeparator: \.isWhitespace).joined(separator: " ") ?? ""
      let fallback = first.count > maxFallback ? String(first.prefix(maxFallback - 1)) + "…" : first
      let recap = episodes[id]?.recap ?? ""
      groups[i].fold = !recap.isEmpty ? recap : !fallback.isEmpty ? fallback : "Earlier conversation"
    }
    return groups
  }
}

/// Chat commands (CHAT_COMMANDS in packages/shared): the brain runs them itself, without the model.
struct ChatCommand: Identifiable, Equatable, Sendable {
  let name: String
  let args: String
  let description: String

  var id: String { name }
  /// It needs more after its name, so choosing it leaves it in the composer to finish.
  var needsMore: Bool { args.hasPrefix("<") }

  static let all = [
    ChatCommand(name: "new", args: "", description: "Start a new conversation"),
    ChatCommand(name: "stop", args: "[task number]", description: "Stop the reply, or a task"),
    ChatCommand(name: "task", args: "<what to do>", description: "Run it as a background task"),
    ChatCommand(name: "remember", args: "<fact>", description: "Save it to memory as written"),
  ]

  /// The ones that work in incognito: the rest would outlast it.
  static let incognito: Set = ["new", "stop"]

  /// The commands a composer's "/…" could mean, while you type the name.
  static func matching(_ text: String, incognito: Bool = false) -> [ChatCommand] {
    guard text.hasPrefix("/") else { return [] }
    let typed = text.dropFirst().lowercased()
    guard typed.allSatisfy({ $0.isASCII && $0.isLetter }) else { return [] }
    return all.filter { $0.name.hasPrefix(typed) && (!incognito || Self.incognito.contains($0.name)) }
  }
}
