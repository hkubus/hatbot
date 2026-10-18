// API types, mirroring packages/shared/src/index.ts. Unknown enum values from a newer brain, and
// ones missing on an older brain, decode to a fallback instead of failing the whole response.
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

extension KeyedDecodingContainer {
  /// Synthesized decoders use this one too, so a type needn't write its own for a field that's missing on
  /// older brains.
  func decode<T: LenientEnum>(_ type: T.Type, forKey key: Key) throws -> T {
    try decodeIfPresent(type, forKey: key) ?? .fallback
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

  /// "task" and "schedule" messages show the thing they point at; `text` is a fallback. "command": a
  /// command you typed, or what came of it.
  enum Kind: String, LenientEnum {
    case text, task, schedule, command
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
  var createdAt: String { didSet { date = Format.date(createdAt) } }
  /// `createdAt`, parsed once: the chat compares every message's to the one before.
  private(set) var date: Date?
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
  /// In the incognito conversation, which isn't kept; missing otherwise.
  var incognito: Bool?
  /// The web pages it cites, in the order it first cites them; missing when none.
  var sources: [Source]?
  /// The answers to tap when it ends with questions, a list for each (empty for an open one); missing
  /// otherwise.
  var choices: [[String]]?
  /// The chat it's in: a bot's own, or a group. Missing on brains from before bots.
  var conversationId: Int?
  /// The bot that wrote it; nil for yours.
  var botId: String?

  var isIncognito: Bool { incognito == true }

  /// What came of a command you ran, shown as a quiet line; one that started a task shows like a reply.
  var isNote: Bool { role == .assistant && kind == .command && taskId == nil }

  private enum CodingKeys: String, CodingKey {
    case id, role, kind, text, status, createdAt, taskId, scheduleId, episodeId, editedAt, seenAt, attachments
    case incognito, conversationId, botId, sources
  }

  init(
    id: Int, role: Role, kind: Kind, text: String, status: Status, createdAt: String, taskId: Int? = nil,
    scheduleId: Int? = nil, episodeId: Int? = nil, editedAt: String? = nil, seenAt: String? = nil,
    attachments: [Attachment]? = nil, incognito: Bool? = nil, conversationId: Int? = nil, botId: String? = nil,
    sources: [Source]? = nil
  ) {
    self.id = id
    self.role = role
    self.kind = kind
    self.text = text
    self.status = status
    self.createdAt = createdAt
    date = Format.date(createdAt)
    self.taskId = taskId
    self.scheduleId = scheduleId
    self.episodeId = episodeId
    self.editedAt = editedAt
    self.seenAt = seenAt
    self.attachments = attachments
    self.incognito = incognito
    self.conversationId = conversationId
    self.botId = botId
    self.sources = sources
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      id: c.decode(Int.self, forKey: .id),
      role: c.decode(Role.self, forKey: .role),
      kind: c.decode(Kind.self, forKey: .kind),
      text: c.decode(String.self, forKey: .text),
      status: c.decode(Status.self, forKey: .status),
      createdAt: c.decode(String.self, forKey: .createdAt),
      taskId: c.decodeIfPresent(Int.self, forKey: .taskId),
      scheduleId: c.decodeIfPresent(Int.self, forKey: .scheduleId),
      episodeId: c.decodeIfPresent(Int.self, forKey: .episodeId),
      editedAt: c.decodeIfPresent(String.self, forKey: .editedAt),
      seenAt: c.decodeIfPresent(String.self, forKey: .seenAt),
      attachments: c.decodeIfPresent([Attachment].self, forKey: .attachments),
      incognito: c.decodeIfPresent(Bool.self, forKey: .incognito),
      conversationId: c.decodeIfPresent(Int.self, forKey: .conversationId),
      botId: c.decodeIfPresent(String.self, forKey: .botId),
      sources: c.decodeIfPresent([Source].self, forKey: .sources))
  }
}

/// A web page a reply cites.
struct Source: Codable, Equatable, Hashable, Sendable {
  let url: String
  let title: String
}

/// A file on a message: one you attached, or one Hatbot or a task sent you.
struct Attachment: Codable, Identifiable, Hashable, Sendable {
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
  /// Opened in the reader rather than Quick Look.
  var isMarkdown: Bool { mediaType == "text/markdown" || name.lowercased().hasSuffix(".md") }
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
  case waitingAnswer = "waiting_answer"
  case done, failed, cancelled
  static let fallback = TaskStatus.running
}

/// A task (PLAN.md §5.1). Not `Task`, which is Swift's.
struct AgentTask: Codable, Identifiable, Equatable, Sendable {
  enum Origin: String, LenientEnum {
    case chat, schedule, webhook, alert, watch, heartbeat
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
  /// The bot doing it; missing on brains from before bots.
  var botId: String?
  /// The bot that handed it over with ask_bot.
  var requestedBy: String?
  /// A research task (PLAN.md §17); missing on brains from before research.
  var research: Bool?
  /// A research task's report, in memory; missing on brains from before research.
  var reportPath: String?
  /// The to-do item it works on, ticked off when it ends done; missing on older brains.
  var todo: String?

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
  var isModelNote: Bool { kind == .note && name == "Note" }
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
  /// Missing on brains from before task files.
  let attachments: [Attachment]?
}

/// A background task's question to you (PLAN.md §20); it waits for your answer.
struct Question: Codable, Identifiable, Equatable, Sendable {
  enum Status: String, LenientEnum {
    case pending, answered, expired, cancelled
    static let fallback = Status.cancelled
  }

  let id: Int
  var botId: String
  var taskId: Int
  var conversationId: Int?
  var question: String
  var choices: [String]
  /// Untrusted things the task had read when it asked. Missing on brains from before.
  var sources: [String]?
  var status: Status
  var answer: String?
  var createdAt: String
  var expiresAt: String
}

struct Approval: Codable, Identifiable, Equatable, Sendable {
  enum Status: String, LenientEnum {
    case pending, approved, denied, expired, cancelled
    static let fallback = Status.cancelled
  }

  let id: Int
  var taskId: Int?
  /// ApprovalKind: send, purchase, payment, mandate (a negotiation's, PLAN.md §16.1) and the rest. A
  /// String, so a kind this app doesn't know still shows.
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
  /// The bot asking.
  var botId: String?

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
  /// The bot whose task that is, and whose browser profile is open.
  var botId: String?
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
  /// The bot it runs as; missing on brains from before bots.
  var botId: String?
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
  /// The bot it runs as; missing on brains from before bots.
  var botId: String?
}

/// One of your bots (PLAN.md §14): its own role, chat, memory folder, plugins and browser profile.
struct Bot: Codable, Identifiable, Equatable, Sendable {
  static let hatbot = "hatbot"

  let id: String
  var name: String
  /// Missing on brains from before them: the fallbacks.
  var icon: Icon = .hat
  var color: Tint = .amber
  /// Its role, in the owner's words.
  var instructions: String
  /// nil: as in Settings.
  var chatModel: AppSettings.ModelID?
  var chatEffort: AppSettings.Effort?
  /// nil: every plugin that's on.
  var plugins: [String]?
  var createdAt: String

  /// BOT_ICONS in packages/shared, each with its SF Symbol.
  enum Icon: String, LenientEnum, CaseIterable {
    case hat, sparkles, brain, code, terminal, server, wrench, shield, globe, house, book, pen, chart
    case mail, cart, cat, heart
    static let fallback = Icon.hat

    var symbol: String {
      switch self {
      case .hat: "hat.widebrim"
      case .code: "chevron.left.forwardslash.chevron.right"
      case .server: "server.rack"
      case .wrench: "wrench.adjustable"
      case .pen: "pencil"
      case .chart: "chart.xyaxis.line"
      case .mail: "envelope"
      default: rawValue
      }
    }
  }

  /// BOT_COLORS in packages/shared: Apple's system colours, with Hatbot's amber first.
  enum Tint: String, LenientEnum, CaseIterable {
    case amber, red, pink, purple, indigo, blue, teal, green, gray
    static let fallback = Tint.amber
  }
}

/// A starting point for a new bot (PLAN.md §14.6), from GET /bot-templates.
struct BotTemplate: Decodable, Identifiable, Equatable, Sendable {
  let id: String
  var name: String
  var icon: Bot.Icon
  var color: Bot.Tint
  var instructions: String
  var chatModel: AppSettings.ModelID?
  var chatEffort: AppSettings.Effort?
  var plugins: [String]?
}

/// A plugin, as far as a bot's page needs it.
struct PluginName: Decodable, Identifiable, Equatable, Sendable {
  let id: String
  var name: String
}

/// "@" in a group's composer (PLAN.md §14.4).
enum Mention {
  /// What's typed after an "@" at the end of `draft`, or nil when it doesn't end in one.
  static func partial(_ draft: String) -> String? {
    guard let at = draft.lastIndex(of: "@") else { return nil }
    let typed = draft[draft.index(after: at)...]
    if typed.contains(where: { $0.isWhitespace || $0 == "@" }) { return nil }
    if at != draft.startIndex, !draft[draft.index(before: at)].isWhitespace { return nil }
    return String(typed)
  }

  /// `draft` with its partial mention finished as "@Name ".
  static func complete(_ draft: String, with name: String) -> String {
    guard let partial = partial(draft) else { return draft }
    return String(draft.dropLast(partial.count + 1)) + "@\(name) "
  }

  /// The bots whose name or id starts with what's typed.
  static func matching(_ partial: String, in bots: [Bot]) -> [Bot] {
    let p = partial.lowercased()
    return bots.filter { $0.id.hasPrefix(p) || $0.name.lowercased().hasPrefix(p) }
  }
}

/// A chat: one bot's own, or a group of bots and you.
struct Conversation: Codable, Identifiable, Equatable, Sendable {
  enum Kind: String, LenientEnum {
    case direct, group
    static let fallback = Kind.direct
  }

  let id: Int
  var kind: Kind
  /// A group's name; nil for a bot's own chat, which goes by the bot's.
  var title: String?
  var botIds: [String]
  /// Messages from its bots you haven't seen.
  var unread: Int
  var lastMessageAt: String?
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
  /// A research task's starting limit; nil from brains before it.
  var researchUsd: Double?
  var dailyUsd: Double
  var monthlyUsd: Double
  /// The last of the daily and monthly limits, which only alerts and the heartbeat spend; nil from
  /// brains before it.
  var alertReserveUsd: Double?
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

  /// Open, like the models below: an effort this app doesn't know yet stays as the brain sent it, so
  /// saving a bot or a setting doesn't quietly turn it into one it knows.
  struct Effort: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let low = Effort(rawValue: "low")
    static let medium = Effort(rawValue: "medium")
    static let high = Effort(rawValue: "high")
    static let xhigh = Effort(rawValue: "xhigh")
    static let max = Effort(rawValue: "max")
    static let known = [low, medium, high, xhigh, max]

    /// "Extra high"; one this app doesn't know, capitalized.
    var name: String { self == .xhigh ? "Extra high" : rawValue.capitalized }
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
  var desktopModel: ModelID?
  /// A desktop task Haiku fails at carries on once on Opus; missing on older brains.
  var desktopEscalate: Bool?
  /// The model background tasks run on; missing on brains from before the setting.
  var taskModel: ModelID?
  /// The chat's model; missing on brains from before the setting.
  var chatModel: ModelID?
  /// Changes Haiku finds safe go ahead without asking; missing on older brains.
  var reviewChanges: Bool?
  /// Every few minutes a look over what went wrong; missing on older brains.
  var heartbeat: Heartbeat?
  /// The week in a few lines, in the chat and as a notification; missing on older brains.
  var weeklyReport: WeeklyReport?
  /// A tidy-up of memory proposed weekly; missing on older brains.
  var memoryTidy: Bool?
  /// The hour the to-do list's morning reminder goes out; missing on older brains.
  var todoHour: Int?

  struct Heartbeat: Codable, Equatable, Sendable {
    var enabled: Bool
    var everyMinutes: Int
    var botId: String
    var instructions: String
  }

  struct WeeklyReport: Codable, Equatable, Sendable {
    var enabled: Bool
    /// 0 is Sunday.
    var weekday: Int
    var hour: Int
  }

  /// The chat's, a bot's, background tasks' or desktop tasks' model.
  struct ModelID: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }
    static let haiku = ModelID(rawValue: "claude-haiku-5-5")
    static let opus = ModelID(rawValue: "claude-opus-5-5")
    static let known = [haiku, opus]

    /// "Opus 5.5"; one of another shape as it is.
    var name: String { Format.modelName(rawValue) }
  }
}

extension Array where Element: Equatable {
  /// A picker's choices, and the value set now when it isn't one of them (set on the web, newer than this
  /// app, or gone), so the picker has a row for it.
  func including(_ current: Element?) -> [Element] {
    guard let current, !contains(current) else { return self }
    return self + [current]
  }
}

/// Live events on /api/v1/stream. Events this app doesn't know, or doesn't show yet (negotiations),
/// decode to `.unknown`.
enum HatbotEvent: Decodable, Sendable {
  case messageCreated(ThreadMessage)
  /// `at`: where `text` starts in the reply, in UTF-16 units; an older brain doesn't say.
  case messageDelta(id: Int, text: String, at: Int? = nil)
  case messageProgress(id: Int, text: String)
  case messageDone(
    id: Int, text: String, status: ThreadMessage.Status, sources: [Source]? = nil, choices: [[String]]? = nil)
  case messageTask(id: Int, taskId: Int)
  case messageEdited(id: Int, editedAt: String)
  case messageRewrite(id: Int)
  case messageSeen(ids: [Int], seenAt: String)
  /// These messages are gone: the incognito conversation they were in ended.
  case messageDeleted(ids: [Int])
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
  case questionCreated(Question)
  case questionResolved(Question)
  case desktopState(DesktopState)
  case scheduleUpdated(Schedule)
  case scheduleDeleted(id: Int)
  case triggerUpdated(Trigger)
  case triggerDeleted(id: Int)
  case episodeUpdated(Episode)
  case botUpdated(Bot)
  case botDeleted(id: String)
  case conversationUpdated(Conversation)
  case conversationDeleted(id: Int)
  case proposalUpdated(Proposal)
  case watcherUpdated(Watcher)
  /// Settings changed, here or elsewhere: open settings refetch.
  case settingsUpdated
  /// The heartbeat looked again.
  case heartbeatUpdated
  case watcherDeleted(id: Int)
  case unknown(String)

  private enum Key: String, CodingKey {
    case type, message, id, text, status, taskId, todayUsd, monthUsd, sha, author, paused, tokens, costUsd
    case task, step, approval, state, schedule, trigger, episode, editedAt, ids, seenAt, attachment
    case bot, conversation, proposal, watcher, sources, at, question, choices
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    // Each field is read as the type its case takes.
    func v<T: Decodable>(_ key: Key) throws -> T { try c.decode(T.self, forKey: key) }
    func maybe<T: Decodable>(_ key: Key) throws -> T? { try c.decodeIfPresent(T.self, forKey: key) }
    let type: String = try v(.type)
    switch type {
    case "message.created": self = try .messageCreated(v(.message))
    case "message.delta": self = try .messageDelta(id: v(.id), text: v(.text), at: maybe(.at))
    case "message.progress": self = try .messageProgress(id: v(.id), text: v(.text))
    case "message.done":
      self = try .messageDone(
        id: v(.id), text: v(.text), status: v(.status), sources: maybe(.sources), choices: maybe(.choices))
    case "message.task": self = try .messageTask(id: v(.id), taskId: v(.taskId))
    case "message.edited": self = try .messageEdited(id: v(.id), editedAt: v(.editedAt))
    case "message.rewrite": self = try .messageRewrite(id: v(.id))
    case "message.seen": self = try .messageSeen(ids: v(.ids), seenAt: v(.seenAt))
    case "message.deleted": self = try .messageDeleted(ids: v(.ids))
    case "message.usage": self = try .messageUsage(id: v(.id), ReplyUsage(tokens: v(.tokens), costUsd: v(.costUsd)))
    case "message.attachment": self = try .messageAttachment(id: v(.id), v(.attachment))
    case "spend.updated": self = try .spendUpdated(todayUsd: v(.todayUsd), monthUsd: v(.monthUsd))
    case "memory.committed": self = try .memoryCommitted(sha: v(.sha), message: v(.message), author: v(.author))
    case "paused": self = try .paused(v(.paused))
    case "task.updated": self = try .taskUpdated(v(.task))
    case "task.step": self = try .taskStep(v(.step))
    case "task.progress": self = try .taskProgress(taskId: v(.taskId), text: v(.text))
    case "approval.created": self = try .approvalCreated(v(.approval))
    case "approval.resolved": self = try .approvalResolved(v(.approval))
    case "question.created": self = try .questionCreated(v(.question))
    case "question.resolved": self = try .questionResolved(v(.question))
    case "desktop.state": self = try .desktopState(v(.state))
    case "schedule.updated": self = try .scheduleUpdated(v(.schedule))
    case "schedule.deleted": self = try .scheduleDeleted(id: v(.id))
    case "trigger.updated": self = try .triggerUpdated(v(.trigger))
    case "trigger.deleted": self = try .triggerDeleted(id: v(.id))
    case "episode.updated": self = try .episodeUpdated(v(.episode))
    case "bot.updated": self = try .botUpdated(v(.bot))
    case "bot.deleted": self = try .botDeleted(id: v(.id))
    case "conversation.updated": self = try .conversationUpdated(v(.conversation))
    case "conversation.deleted": self = try .conversationDeleted(id: v(.id))
    case "proposal.updated": self = try .proposalUpdated(v(.proposal))
    case "watcher.updated": self = try .watcherUpdated(v(.watcher))
    case "settings.updated": self = .settingsUpdated
    case "heartbeat.updated": self = .heartbeatUpdated
    case "watcher.deleted": self = try .watcherDeleted(id: v(.id))
    default: self = .unknown(type)
    }
  }
}

/// What you do on the desktop while you have control (LiveInput in packages/shared/src/desktop.ts):
/// `t` says which, and only the fields it has are sent.
struct LiveInput: Encodable, Sendable {
  var t: String
  var x, y: Double?
  var button: Int?
  var down: Bool?
  var dx, dy: Double?
  var key: String?

  static func move(x: Double, y: Double) -> Self { Self(t: "move", x: x, y: y) }

  static func button(_ button: Int, down: Bool, x: Double, y: Double) -> Self {
    Self(t: "button", x: x, y: y, button: button, down: down)
  }

  static func wheel(dx: Double, dy: Double, x: Double, y: Double) -> Self {
    Self(t: "wheel", x: x, y: y, dx: dx, dy: dy)
  }

  static func key(_ key: String, down: Bool) -> Self { Self(t: "key", down: down, key: key) }
}
