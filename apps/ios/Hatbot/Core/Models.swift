// API types, mirroring packages/shared/src/index.ts. Unknown enum values from a newer brain
// decode to a fallback instead of failing the whole response.
import Foundation

protocol LenientEnum: RawRepresentable<String>, Codable, Sendable {
  static var fallback: Self { get }
}

extension LenientEnum {
  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: raw) ?? .fallback
  }
}

struct Me: Decodable, Sendable {
  let setupDone: Bool
  let authenticated: Bool
}

struct LoginResponse: Decodable, Sendable {
  let token: String?
}

struct ThreadMessage: Codable, Identifiable, Equatable, Sendable {
  enum Role: String, LenientEnum {
    case user, assistant
    static let fallback = Role.assistant
  }

  /// "task" and "schedule" messages show the thing they point at; `text` is a fallback.
  enum Kind: String, LenientEnum {
    case text, task, schedule
    static let fallback = Kind.text
  }

  enum Status: String, LenientEnum {
    case streaming, done, error
    static let fallback = Status.done
  }

  let id: Int
  var role: Role
  var kind: Kind
  var text: String
  var status: Status
  var createdAt: String
  var taskId: Int?
  var scheduleId: Int?
  /// The conversation it belongs to; cards from background tasks have none.
  var episodeId: Int?
  /// When a task's result changed it after it was sent; missing on brains from before.
  var editedAt: String?
  /// When you last saw it; missing on brains from before.
  var seenAt: String?
  /// Its files, and for a message showing a task, the task's; missing when there are none.
  var attachments: [Attachment]?
}

/// A file on a message: one you attached, or one Hatbot or a task sent you.
struct Attachment: Codable, Identifiable, Equatable, Sendable {
  enum From: String, LenientEnum {
    case owner, hatbot
    static let fallback = From.hatbot
  }

  let id: Int
  var name: String
  var mediaType: String
  var size: Int
  var from: From
  var createdAt: String

  /// Shown as a picture rather than a file.
  var isPicture: Bool { ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"].contains(mediaType) }
}

/// A conversation in the thread. Finished ones fold up under their recap.
struct Episode: Codable, Identifiable, Equatable, Sendable {
  let id: Int
  var startedAt: String
  var lastActivityAt: String
  /// Null until it has been idle for 30 minutes, and for conversations from before recaps.
  var recap: String?
}

enum TaskStatus: String, LenientEnum {
  case queued, running
  case waitingApproval = "waiting_approval"
  case waitingTakeover = "waiting_takeover"
  case done, failed, cancelled
  static let fallback = TaskStatus.running
}

/// A task (PLAN.md §5.1). Not `Task`, which is Swift's.
struct AgentTask: Codable, Identifiable, Equatable, Sendable {
  enum Origin: String, LenientEnum {
    case chat, schedule, webhook, alert
    static let fallback = Origin.chat
  }

  enum Lane: String, LenientEnum {
    case screen, background
    static let fallback = Lane.background
  }

  let id: Int
  var title: String
  var goal: String
  var successCriteria: String
  var origin: Origin
  var lane: Lane
  var source: String?
  var scheduleId: Int?
  var triggerId: Int?
  var parentId: Int?
  var payload: String?
  var model: String
  /// Desktop tasks: the skill (skills/<name>.md) it follows.
  var skill: String?
  var status: TaskStatus
  var tainted: Bool
  /// The first untrusted thing it read, or what started it tainted.
  var taintedBy: String?
  var injectionSuspected: Bool
  var summary: String?
  var costUsd: Double
  var steps: Int
  var createdAt: String
  var startedAt: String?
  var finishedAt: String?

  var isActive: Bool { finishedAt == nil }
}

struct TaskStep: Codable, Identifiable, Equatable, Sendable {
  enum Kind: String, LenientEnum {
    case note, action, screenshot, page, approval, takeover, error, task
    static let fallback = Kind.note
  }

  let id: Int
  var taskId: Int
  var kind: Kind
  var name: String
  var detail: String
  var screenshot: String?
  var url: String?
  var createdAt: String

  /// The model's own notes; yours on approvals are named "Your note".
  var isModelNote: Bool { kind == .note && name != "Your note" }
}

extension [TaskStep] {
  /// With only the model's latest note; your own notes on approvals stay.
  var latestNoteOnly: [TaskStep] {
    let last = self.last(where: \.isModelNote)?.id
    return filter { !$0.isModelNote || $0.id == last }
  }
}

struct TaskWithSteps: Decodable, Sendable {
  let task: AgentTask
  let steps: [TaskStep]
}

struct Approval: Codable, Identifiable, Equatable, Sendable {
  enum Status: String, LenientEnum {
    case pending, approved, denied, expired, cancelled
    static let fallback = Status.cancelled
  }

  let id: Int
  var taskId: Int?
  var kind: String
  var summary: String
  var reason: String
  var sources: [String]
  var screenshotStepId: Int?
  var status: Status
  var decidedVia: String?
  var costUsd: Double
  var createdAt: String
  var expiresAt: String
  var decidedAt: String?
  /// What you told the task along with your decision.
  var note: String?

  /// Whether the answer can carry a note: the task carries on afterwards.
  var takesNote: Bool { kind != "budget" && kind != "injection_warning" }
}

enum Decision: String, Encodable, Sendable {
  case approve, deny
}

struct DesktopState: Codable, Equatable, Sendable {
  struct Request: Codable, Equatable, Sendable {
    var taskId: Int
    var reason: String
  }

  enum Control: String, LenientEnum {
    case hatbot, owner
    static let fallback = Control.hatbot
  }

  var online: Bool
  var control: Control
  var request: Request?
  var activeTaskId: Int?
}

struct Schedule: Codable, Identifiable, Equatable, Sendable {
  let id: Int
  var name: String
  var cron: String?
  var runAt: String?
  var prompt: String
  var enabled: Bool
  var createdVia: String
  var createdAt: String
  var nextRunAt: String?
  var lastRunAt: String?
  var lastTaskId: Int?
  /// The chat made or changed it after reading untrusted content; saving it yourself clears this.
  var tainted: Bool?
  /// What the chat had read.
  var taintedBy: String?
}

/// A webhook or Uptime Kuma trigger (packages/shared/src/schedule.ts).
struct Trigger: Codable, Identifiable, Equatable, Sendable {
  enum Kind: String, LenientEnum {
    case webhook, kuma
    static let fallback = Kind.webhook
  }

  let id: Int
  var name: String
  var kind: Kind
  /// Its payloads count as trusted content. Uptime Kuma alerts always do.
  var trusted: Bool
  var prompt: String
  var enabled: Bool
  /// Uptime Kuma: how many more of the monitor's checks a down alert waits for, 0 to 2; one back up in
  /// the meantime starts nothing. Missing on older brains.
  var confirmChecks: Int?
  /// Where to send events.
  var url: String
  var createdAt: String
  var lastFiredAt: String?
  var lastTaskId: Int?
}

/// A trigger with its secret: only right after it's made or the secret is replaced.
struct TriggerWithSecret: Decodable, Sendable {
  let trigger: Trigger
  let secret: String

  private enum Key: String, CodingKey { case secret }

  init(from decoder: Decoder) throws {
    trigger = try Trigger(from: decoder)
    secret = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .secret)
  }

  /// What to paste into the sender: Uptime Kuma's Post URL carries the secret.
  var postURL: String { trigger.kind == .kuma ? "\(trigger.url)?token=\(secret)" : trigger.url }
}

struct MemoryFile: Codable, Identifiable, Equatable, Sendable {
  var path: String
  var size: Int
  var id: String { path }
}

struct MemoryCommit: Codable, Identifiable, Equatable, Hashable, Sendable {
  var sha: String
  var author: String
  var date: String
  var message: String
  var files: [String]
  var id: String { sha }
}

struct Limits: Codable, Equatable, Sendable {
  var taskUsd: Double
  var dailyUsd: Double
  var monthlyUsd: Double
}

struct SpendWindow: Codable, Equatable, Sendable {
  var usd: Double
  var tokens: Int
}

struct SpendSummary: Codable, Equatable, Sendable {
  var todayUsd: Double
  var monthUsd: Double
  var limits: Limits
  /// Missing on brains from before token counts.
  var todayTokens: Int?
  var lastHour: SpendWindow?
  var lastMinute: SpendWindow?
}

/// What a reply being written has used so far.
struct ReplyUsage: Equatable, Sendable {
  var tokens: Int
  var costUsd: Double
}

struct AppSettings: Codable, Equatable, Sendable {
  struct Owner: Codable, Equatable, Sendable {
    var name: String
    var email: String
  }

  enum Effort: String, LenientEnum, CaseIterable {
    case low, medium
    static let fallback = Effort.low
  }

  /// What tapping a notification opens.
  enum Opens: String, LenientEnum, CaseIterable {
    case web, app
    static let fallback = Opens.web
  }

  var limits: Limits
  var chatEffort: Effort
  var owner: Owner
  var paused: Bool
  /// Missing on brains from before the setting.
  var notificationsOpen: Opens?
  /// The model that drives desktop tasks; missing on brains from before the setting.
  var desktopModel: DesktopModel?
  /// The model background tasks run on; missing on brains from before the setting.
  var taskModel: TaskModel?
  /// The chat's model; missing on brains from before the setting.
  var chatModel: ChatModel?
  /// A task from the chat doesn't ask again for what you asked for; missing on older brains.
  var skipAskedApprovals: Bool?
  /// After untrusted content, a task makes changes Haiku finds safe without asking; missing on older brains.
  var reviewTaintedChanges: Bool?

  enum ChatModel: String, LenientEnum, CaseIterable {
    case haiku = "claude-haiku-5-5"
    case opus = "claude-opus-5-5"
    static let fallback = ChatModel.haiku
  }

  enum DesktopModel: String, LenientEnum, CaseIterable {
    case opus = "claude-opus-5-5"
    case haiku = "claude-haiku-5-5"
    static let fallback = DesktopModel.opus
  }

  enum TaskModel: String, LenientEnum, CaseIterable {
    case haiku = "claude-haiku-5-5"
    case opus = "claude-opus-5-5"
    static let fallback = TaskModel.haiku
  }
}

/// Live events on /api/v1/stream. Events this app doesn't know decode to `.unknown`.
enum HatbotEvent: Decodable, Sendable {
  case messageCreated(ThreadMessage)
  case messageDelta(id: Int, text: String)
  case messageProgress(id: Int, text: String)
  case messageDone(id: Int, text: String, status: ThreadMessage.Status)
  case messageTask(id: Int, taskId: Int)
  case messageEdited(id: Int, editedAt: String)
  case messageSeen(ids: [Int], seenAt: String)
  case messageUsage(id: Int, ReplyUsage)
  case messageAttachment(id: Int, Attachment)
  case spendUpdated(todayUsd: Double, monthUsd: Double)
  case memoryCommitted(sha: String, message: String, author: String)
  case paused(Bool)
  case taskUpdated(AgentTask)
  case taskStep(TaskStep)
  case taskProgress(taskId: Int, text: String)
  case approvalCreated(Approval)
  case approvalResolved(Approval)
  case desktopState(DesktopState)
  case scheduleUpdated(Schedule)
  case scheduleDeleted(id: Int)
  case triggerUpdated(Trigger)
  case triggerDeleted(id: Int)
  case episodeUpdated(Episode)
  case unknown(String)

  private enum Key: String, CodingKey {
    case type, message, id, text, status, taskId, todayUsd, monthUsd, sha, author, paused, tokens, costUsd
    case task, step, approval, state, schedule, trigger, episode, editedAt, ids, seenAt, attachment
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "message.created": self = .messageCreated(try c.decode(ThreadMessage.self, forKey: .message))
    case "message.delta":
      self = .messageDelta(id: try c.decode(Int.self, forKey: .id), text: try c.decode(String.self, forKey: .text))
    case "message.progress":
      self = .messageProgress(id: try c.decode(Int.self, forKey: .id), text: try c.decode(String.self, forKey: .text))
    case "message.done":
      self = .messageDone(
        id: try c.decode(Int.self, forKey: .id),
        text: try c.decode(String.self, forKey: .text),
        status: try c.decode(ThreadMessage.Status.self, forKey: .status))
    case "message.task":
      self = .messageTask(id: try c.decode(Int.self, forKey: .id), taskId: try c.decode(Int.self, forKey: .taskId))
    case "message.edited":
      self = .messageEdited(id: try c.decode(Int.self, forKey: .id), editedAt: try c.decode(String.self, forKey: .editedAt))
    case "message.seen":
      self = .messageSeen(ids: try c.decode([Int].self, forKey: .ids), seenAt: try c.decode(String.self, forKey: .seenAt))
    case "message.usage":
      self = .messageUsage(
        id: try c.decode(Int.self, forKey: .id),
        ReplyUsage(tokens: try c.decode(Int.self, forKey: .tokens), costUsd: try c.decode(Double.self, forKey: .costUsd)))
    case "message.attachment":
      self = .messageAttachment(id: try c.decode(Int.self, forKey: .id), try c.decode(Attachment.self, forKey: .attachment))
    case "spend.updated":
      self = .spendUpdated(
        todayUsd: try c.decode(Double.self, forKey: .todayUsd),
        monthUsd: try c.decode(Double.self, forKey: .monthUsd))
    case "memory.committed":
      self = .memoryCommitted(
        sha: try c.decode(String.self, forKey: .sha),
        message: try c.decode(String.self, forKey: .message),
        author: try c.decode(String.self, forKey: .author))
    case "paused": self = .paused(try c.decode(Bool.self, forKey: .paused))
    case "task.updated": self = .taskUpdated(try c.decode(AgentTask.self, forKey: .task))
    case "task.step": self = .taskStep(try c.decode(TaskStep.self, forKey: .step))
    case "task.progress":
      self = .taskProgress(taskId: try c.decode(Int.self, forKey: .taskId), text: try c.decode(String.self, forKey: .text))
    case "approval.created": self = .approvalCreated(try c.decode(Approval.self, forKey: .approval))
    case "approval.resolved": self = .approvalResolved(try c.decode(Approval.self, forKey: .approval))
    case "desktop.state": self = .desktopState(try c.decode(DesktopState.self, forKey: .state))
    case "schedule.updated": self = .scheduleUpdated(try c.decode(Schedule.self, forKey: .schedule))
    case "schedule.deleted": self = .scheduleDeleted(id: try c.decode(Int.self, forKey: .id))
    case "trigger.updated": self = .triggerUpdated(try c.decode(Trigger.self, forKey: .trigger))
    case "trigger.deleted": self = .triggerDeleted(id: try c.decode(Int.self, forKey: .id))
    case "episode.updated": self = .episodeUpdated(try c.decode(Episode.self, forKey: .episode))
    default: self = .unknown(type)
    }
  }
}

/// What you do on the desktop while you have control (LiveInput in packages/shared/src/desktop.ts).
enum LiveInput: Encodable, Sendable {
  case move(x: Double, y: Double)
  case button(Int, down: Bool, x: Double, y: Double)
  case wheel(dx: Double, dy: Double, x: Double, y: Double)
  case key(String, down: Bool)

  private enum Key: String, CodingKey {
    case t, x, y, button, down, dx, dy, key
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    switch self {
    case let .move(x, y):
      try c.encode("move", forKey: .t)
      try c.encode(x, forKey: .x)
      try c.encode(y, forKey: .y)
    case let .button(button, down, x, y):
      try c.encode("button", forKey: .t)
      try c.encode(button, forKey: .button)
      try c.encode(down, forKey: .down)
      try c.encode(x, forKey: .x)
      try c.encode(y, forKey: .y)
    case let .wheel(dx, dy, x, y):
      try c.encode("wheel", forKey: .t)
      try c.encode(dx, forKey: .dx)
      try c.encode(dy, forKey: .dy)
      try c.encode(x, forKey: .x)
      try c.encode(y, forKey: .y)
    case let .key(key, down):
      try c.encode("key", forKey: .t)
      try c.encode(key, forKey: .key)
      try c.encode(down, forKey: .down)
    }
  }
}
