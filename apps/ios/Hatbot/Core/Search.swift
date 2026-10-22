// Mirrors packages/shared/src/search.ts.
import Foundation

struct SearchResults: Decodable, Sendable {
  struct MessageHit: Decodable, Identifiable, Sendable {
    let id: Int
    var conversationId: Int
    /// Who wrote it: nil for you.
    var botId: String?
    /// The text around the match, with marks around the matched words (see `Search.parts`).
    var snippet: String
    var createdAt: String
  }

  struct MemoryHit: Decodable, Identifiable, Sendable {
    var path: String
    var line: Int
    var text: String
    var id: String { "\(path):\(line)" }
  }

  struct RoutineHit: Decodable, Identifiable, Sendable {
    enum Kind: String, LenientEnum {
      case schedule, trigger, watcher
      static let fallback = Kind.schedule
    }

    var kind: Kind
    var id: Int
    var name: String
  }

  var query: String
  var messages: [MessageHit]
  var tasks: [AgentTask]
  var memory: [MemoryHit]
  var routines: [RoutineHit]

  var isEmpty: Bool { messages.isEmpty && tasks.isEmpty && memory.isEmpty && routines.isEmpty }
}

enum Search {
  static let matchStart: Character = "\u{02}"
  static let matchEnd: Character = "\u{03}"

  static func parts(_ snippet: String) -> [(text: String, match: Bool)] {
    var out: [(text: String, match: Bool)] = []
    var run = ""
    var inMatch = false
    for c in snippet {
      if c == matchStart || c == matchEnd {
        if !run.isEmpty { out.append((run, inMatch)) }
        run = ""
        inMatch = c == matchStart
      } else {
        run.append(c)
      }
    }
    if !run.isEmpty { out.append((run, inMatch)) }
    return out
  }
}
