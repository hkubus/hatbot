// What looks after things on its own, mirroring packages/shared/src: watchers (watch.ts), Check
// everything (checks.ts), the heartbeat and weekly report, and proposed memory changes.
import Foundation

/// Looks at a page or a plugin's value on a timer, without the model, and wakes a bot only when it
/// changes the way you asked.
struct Watcher: Codable, Identifiable, Equatable, Sendable {
  struct Source: Codable, Equatable, Sendable {
    enum Kind: String, LenientEnum {
      case page, tool
      static let fallback = Kind.page
    }

    var kind: Kind
    var url: String?
    var tool: String?
    var selector: String?
    var path: String?
    var pattern: String?

    /// The address, or the tool's name.
    var text: String { (kind == .page ? url : tool) ?? "" }
  }

  struct Condition: Codable, Equatable, Sendable {
    enum When: String, LenientEnum {
      case changed, contains, missing, below, above
      static let fallback = When.changed
    }

    var when: When
    var text: String?
    var value: Double?

    /// "Changes", "Contains “In stock”", "Below 1000".
    var description: String {
      switch when {
      case .changed: "Changes"
      case .contains: "Contains “\(text ?? "")”"
      case .missing: "Doesn't contain “\(text ?? "")”"
      case .below: "Below \(Format.number(value ?? 0))"
      case .above: "Above \(Format.number(value ?? 0))"
      }
    }
  }

  let id: Int
  var botId: String
  var name: String
  var source: Source
  var condition: Condition
  var prompt: String
  var everyMinutes: Int
  var once: Bool
  var enabled: Bool
  var tainted: Bool
  var taintedBy: String?
  var createdAt: String
  var nextCheckAt: String?
  var lastCheckedAt: String?
  var lastValue: String?
  var lastChangedAt: String?
  var lastFiredAt: String?
  var lastError: String?
  var errors: Int
  var lastTaskId: Int?

  /// "Every hour", "Every 15 minutes", "Every 2 days".
  static func every(_ minutes: Int) -> String {
    func unit(_ n: Int, _ word: String) -> String { n == 1 ? "Every \(word)" : "Every \(n) \(word)s" }
    if minutes % 1440 == 0 { return unit(minutes / 1440, "day") }
    if minutes % 60 == 0 { return unit(minutes / 60, "hour") }
    return unit(minutes, "minute")
  }
}

/// A value that differed from the one before, and whether it counted.
struct WatcherValue: Codable, Identifiable, Equatable, Sendable {
  let id: Int
  var value: String
  var fired: Bool
  var createdAt: String
}

struct CheckResult: Codable, Identifiable, Equatable, Sendable {
  enum State: String, LenientEnum {
    case ok, warn, fail, skip
    static let fallback = State.warn
  }

  let id: String
  var name: String
  var state: State
  var detail: String
}

struct CheckReport: Codable, Equatable, Sendable {
  var startedAt: String
  var finishedAt: String
  var results: [CheckResult]
}

struct ChecksInfo: Decodable, Sendable {
  var report: CheckReport?
  /// The last test approval; missing on brains from before it.
  var approval: Approval?
}

/// A tidy-up of memory, a fix to a skill, or a write to a skill or index from work that had read
/// untrusted content, shown as a diff to apply or dismiss.
struct Proposal: Codable, Identifiable, Hashable, Sendable {
  enum Kind: String, LenientEnum {
    case tidy, skill, write
    static let fallback = Kind.tidy
  }

  enum Status: String, LenientEnum {
    case pending, applied, dismissed, stale
    static let fallback = Status.stale
  }

  struct Change: Codable, Hashable, Sendable {
    var path: String
    /// nil: a new file.
    var before: String?
    /// nil: deleted.
    var after: String?
  }

  let id: Int
  var kind: Kind
  var title: String
  var reason: String
  var changes: [Change]
  var skill: String?
  var status: Status
  var createdAt: String
  var resolvedAt: String?
}

/// What asking for a tidy-up or a skill fix answers: `202 { started: true }`, the proposal from a brain
/// from before, or nothing (204) when that brain found nothing to change.
struct ProposalStarted: Decodable, Sendable {
  var proposal: Proposal?
  var started: Bool

  private enum Key: String, CodingKey { case started }

  init(from decoder: Decoder) throws {
    proposal = try? Proposal(from: decoder)
    started = (try? decoder.container(keyedBy: Key.self).decodeIfPresent(Bool.self, forKey: .started)) == true
  }
}

/// A skill, and the tasks following it that failed or needed you since it last changed.
struct SkillStatus: Codable, Identifiable, Equatable, Sendable {
  var name: String
  var description: String
  var runs: Int
  var failed: [Int]
  var takeovers: [Int]
  var id: String { name }
  var troubled: Bool { !failed.isEmpty || !takeovers.isEmpty }
}

/// The heartbeat's last look.
struct HeartbeatInfo: Codable, Equatable, Sendable {
  enum Action: String, LenientEnum {
    case nothing, notify, task
    static let fallback = Action.nothing
  }

  /// One look of the ones before.
  struct Run: Codable, Equatable, Sendable {
    var at: String
    var found: [String]
    var action: Action?
  }

  var at: String?
  var found: [String]
  var action: Action?
  var note: String
  var taskId: Int?
  /// The last few looks, newest first; missing on brains from before.
  var recent: [Run]?
}

enum LineDiff {
  /// Lines kept around a change; longer runs of unchanged lines fold into a gap.
  static let context = 2

  /// The longest common subsequence of lines, then the changes with a little context, deletions
  /// before what replaces them; lines start "+", "-" or " " like a commit's diff, and a hunk line
  /// stands for unchanged ones left out. The same as apps/web/src/diff.ts.
  static func of(_ before: String?, _ after: String?) -> [DiffLine] {
    func lines(_ s: String?) -> [String] {
      guard var s else { return [] }
      if s.hasSuffix("\n") { s.removeLast() }
      return s.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }
    let a = lines(before)
    let b = lines(after)
    if a.count * b.count > 4_000_000 {
      return a.map { DiffLine(kind: .removed, text: "-" + $0) } + b.map { DiffLine(kind: .added, text: "+" + $0) }
    }
    var lcs = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
    for i in stride(from: a.count - 1, through: 0, by: -1) {
      for j in stride(from: b.count - 1, through: 0, by: -1) {
        lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
    var all: [DiffLine] = []
    var i = 0
    var j = 0
    while i < a.count || j < b.count {
      if i < a.count && j < b.count && a[i] == b[j] {
        all.append(DiffLine(kind: .context, text: " " + a[i]))
        i += 1
        j += 1
      } else if i < a.count && (j >= b.count || lcs[i + 1][j] >= lcs[i][j + 1]) {
        all.append(DiffLine(kind: .removed, text: "-" + a[i]))
        i += 1
      } else {
        all.append(DiffLine(kind: .added, text: "+" + b[j]))
        j += 1
      }
    }
    var out: [DiffLine] = []
    for (k, l) in all.enumerated() {
      let near = all[max(0, k - context)..<min(all.count, k + context + 1)].contains { $0.kind != .context }
      if l.kind != .context || near {
        out.append(l)
      } else if out.last?.kind != .hunk {
        out.append(DiffLine(kind: .hunk, text: "…"))
      }
    }
    return out
  }
}
