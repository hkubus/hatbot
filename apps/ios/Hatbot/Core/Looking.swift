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
    /// A page loaded in a headless Chromium on the desktop, so what its scripts write is there.
    var render: Bool?
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

  /// Watchers that run a page's scripts look at most this often, in minutes.
  static let minRenderMinutes = 15

  /// What turns running the page's scripts on or off. One that looked more often slows down.
  struct RenderChange: Encodable, Equatable, Sendable {
    var source: Source
    var everyMinutes: Int?
  }

  func render(_ on: Bool) -> RenderChange {
    var s = source
    s.render = on ? true : nil
    let slower = on && everyMinutes < Self.minRenderMinutes
    return RenderChange(source: s, everyMinutes: slower ? Self.minRenderMinutes : nil)
  }

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

extension AppSettings.Heartbeat {
  /// How often it can look, from the Every picker, with the one set now when it's another (on the web,
  /// say), so the picker has a row for it.
  static func everyChoices(with current: Int) -> [Int] {
    let common = [5, 10, 15, 30, 60, 120, 240]
    return common.contains(current) ? common : (common + [current]).sorted()
  }

  /// "5 minutes", "Hour", "2 hours", "90 minutes".
  static func every(_ minutes: Int) -> String {
    if minutes % 60 == 0 { return minutes == 60 ? "Hour" : "\(minutes / 60) hours" }
    return minutes == 1 ? "1 minute" : "\(minutes) minutes"
  }

  /// The bots it can run as, with the one set now when it isn't among them (deleted, or not loaded yet).
  func botChoices(_ botIds: [String]) -> [String] {
    botIds.contains(botId) ? botIds : botIds + [botId]
  }
}

enum LineDiff {
  /// Lines kept around a change; longer runs of unchanged lines fold into a gap.
  static let context = 2
  /// Past this many lines deleted or added, the middle is shown as a whole replacement.
  static let mostEdits = 2_000

  /// The fewest lines deleted and added, then the changes with a little context, deletions before
  /// what replaces them; lines start "+", "-" or " " like a commit's diff, and a hunk line stands for
  /// unchanged ones left out. The same as apps/web/src/diff.ts.
  static func of(_ before: String?, _ after: String?) -> [DiffLine] {
    func lines(_ s: String?) -> [String] {
      guard var s else { return [] }
      if s.hasSuffix("\n") { s.removeLast() }
      return s.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }
    let whole = (a: lines(before), b: lines(after))
    // The lines both versions start and end with are set aside first.
    var head = 0
    while head < min(whole.a.count, whole.b.count) && whole.a[head] == whole.b[head] { head += 1 }
    var tail = 0
    while tail < min(whole.a.count, whole.b.count) - head
      && whole.a[whole.a.count - 1 - tail] == whole.b[whole.b.count - 1 - tail]
    {
      tail += 1
    }
    let a = Array(whole.a[head..<(whole.a.count - tail)])
    let b = Array(whole.b[head..<(whole.b.count - tail)])
    var all = whole.a[..<head].map { DiffLine(kind: .context, text: " " + $0) }
    if let middle = edits(a, b) {
      all += middle
    } else {
      // A huge rewrite: whole replacement rather than a slow search.
      all += a.map { DiffLine(kind: .removed, text: "-" + $0) } + b.map { DiffLine(kind: .added, text: "+" + $0) }
    }
    all += whole.a[(whole.a.count - tail)...].map { DiffLine(kind: .context, text: " " + $0) }
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

  /// Myers' diff: its time grows with the lines times the edits, not with the lines squared, so a few
  /// edits far apart in a long file are cheap. nil past `mostEdits`.
  static func edits(_ a: [String], _ b: [String]) -> [DiffLine]? {
    let n = a.count
    let m = b.count
    let most = min(n + m, mostEdits)
    // v[k + off] is how far along `a` the path on diagonal k (x - y) has got; one snapshot per step.
    let off = most + 1
    var v = [Int](repeating: 0, count: 2 * off + 1)
    var trace: [[Int]] = []
    var found: Int?
    var d = 0
    while d <= most && found == nil {
      for k in stride(from: -d, through: d, by: 2) {
        // Down from k + 1 is an added line, right from k - 1 a deleted one; on a tie, the deletion.
        var x = (k == -d || (k != d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1
        var y = x - k
        while x < n && y < m && a[x] == b[y] {
          x += 1
          y += 1
        }
        v[off + k] = x
        if x >= n && y >= m {
          found = d
          break
        }
      }
      trace.append(Array(v[(off - d)...(off + d)]))
      d += 1
    }
    guard let found else { return nil }
    // Back from the end, step by step.
    var all: [DiffLine] = []
    var x = n
    var y = m
    for d in stride(from: found, to: 0, by: -1) {
      let prev = trace[d - 1]
      let at = { (k: Int) in prev[k + d - 1] }
      let k = x - y
      let down = k == -d || (k != d && at(k - 1) < at(k + 1))
      let px = down ? at(k + 1) : at(k - 1)
      let py = px - (down ? k + 1 : k - 1)
      // The unchanged run after this step's edit, then the edit.
      while x > (down ? px : px + 1) {
        x -= 1
        all.append(DiffLine(kind: .context, text: " " + a[x]))
      }
      all.append(down ? DiffLine(kind: .added, text: "+" + b[py]) : DiffLine(kind: .removed, text: "-" + a[px]))
      x = px
      y = py
    }
    all += a[..<x].reversed().map { DiffLine(kind: .context, text: " " + $0) }
    all.reverse()
    // What goes, before what replaces it.
    var out: [DiffLine] = []
    var run: [DiffLine] = []
    for l in all + [DiffLine(kind: .hunk, text: "")] {
      if l.kind == .added || l.kind == .removed {
        run.append(l)
        continue
      }
      out += run.filter { $0.kind == .removed } + run.filter { $0.kind == .added }
      run = []
      if l.kind == .context { out.append(l) }
    }
    return out
  }
}
