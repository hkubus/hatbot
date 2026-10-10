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
      let first = groups[i].messages.first { $0.role == .user }?.text
        .split(whereSeparator: \.isWhitespace).joined(separator: " ") ?? ""
      let fallback = first.count > maxFallback ? String(first.prefix(maxFallback - 1)) + "…" : first
      let recap = episodes[id]?.recap ?? ""
      groups[i].fold = !recap.isEmpty ? recap : !fallback.isEmpty ? fallback : "Earlier conversation"
    }
    return groups
  }

  /// Once a task has ended, its approvals fold into the message that shows it (the reply that started
  /// it, or its card), so the thread keeps one message per task. Only when that message is loaded too.
  /// By task: its approvals, oldest first.
  static func mergedApprovals(_ messages: [ThreadMessage], ended: (Int) -> Bool) -> [Int: [Int]] {
    let shown = Set(messages.compactMap { $0.kind == .approval ? nil : $0.taskId })
    var merged: [Int: [Int]] = [:]
    for m in messages where m.kind == .approval {
      guard let task = m.taskId, let approval = m.approvalId, shown.contains(task), ended(task) else {
        continue
      }
      merged[task, default: []].append(approval)
    }
    return merged
  }
}
