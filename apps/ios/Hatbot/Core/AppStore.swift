// Live client state: the thread, tasks, approvals, the desktop, pause state and spend, fed by
// the event stream. Same shape as apps/web/src/store.ts.
import Foundation
import Observation

@MainActor
@Observable
final class AppStore {
  static let page = 50

  var messages: [ThreadMessage] = []
  /// The conversations the loaded messages belong to, for their recaps.
  var episodes: [Int: Episode] = [:]
  /// Latest progress note per streaming reply.
  var progress: [Int: String] = [:]
  /// What each streaming reply has used so far.
  var usage: [Int: ReplyUsage] = [:]
  var hasEarlier = false
  var paused = false
  var todayUsd: Double?
  var monthUsd: Double?
  var connected = false
  var tasks: [Int: AgentTask] = [:]
  /// Steps of the tasks that have been opened or shown in the chat.
  var steps: [Int: [TaskStep]] = [:]
  /// Latest progress note per running task.
  var taskProgress: [Int: String] = [:]
  var approvals: [Int: Approval] = [:]
  var desktop: DesktopState?
  var schedules: [Int: Schedule] = [:]
  /// Schedules a message points at that no longer exist.
  var deletedSchedules: Set<Int> = []
  var triggers: [Int: Trigger] = [:]
  var deletedTriggers: Set<Int> = []
  /// Bumped when memory changes, so open memory views reload.
  var memoryVersion = 0
  /// A short note to show briefly, like a memory commit.
  var toast: String?

  @ObservationIgnored let api: API
  @ObservationIgnored private var requested = Set<String>()
  @ObservationIgnored private var stream: Socket?

  init(api: API) {
    self.api = api
  }

  /// Approvals waiting for you, plus a takeover request.
  var needsYou: Int {
    approvals.values.filter { $0.status == .pending }.count + (desktop?.request == nil ? 0 : 1)
  }

  var pendingApprovals: [Approval] {
    approvals.values.filter { $0.status == .pending }.sorted { $0.id < $1.id }
  }

  // MARK: Event stream

  func connect() {
    if stream == nil { stream = makeStream() }
    stream?.start()
  }

  func disconnect() {
    stream?.stop()
    connected = false
  }

  private func makeStream() -> Socket {
    let api = self.api
    let socket = Socket { api.webSocket("/stream") }
    socket.onOpen = { [weak self] reconnected in
      guard let self else { return }
      self.connected = true
      Task {
        if reconnected { try? await self.loadThread() }
        try? await self.loadLive()
      }
    }
    socket.onMessage = { [weak self] message in
      guard case let .text(text) = message,
        let event = try? JSONDecoder().decode(HatbotEvent.self, from: Data(text.utf8))
      else { return }
      self?.apply(event)
    }
    socket.onClose = { [weak self] in self?.connected = false }
    return socket
  }

  func apply(_ event: HatbotEvent) {
    switch event {
    case let .messageCreated(m):
      upsert(m)
    case let .messageDelta(id, text):
      if let i = messages.firstIndex(where: { $0.id == id }) { messages[i].text += text }
    case let .messageProgress(id, text):
      progress[id] = String(((progress[id] ?? "") + text).suffix(400))
    case let .messageTask(id, taskId):
      if let i = messages.firstIndex(where: { $0.id == id }) { messages[i].taskId = taskId }
    case let .messageUsage(id, used):
      usage[id] = used
    case let .messageDone(id, text, status):
      progress[id] = nil
      usage[id] = nil
      if let i = messages.firstIndex(where: { $0.id == id }) {
        messages[i].text = text
        messages[i].status = status
      }
    case let .spendUpdated(today, month):
      todayUsd = today
      monthUsd = month
    case let .memoryCommitted(_, message, author):
      if author == "Hatbot" { toast = "Memory: \(message)" }
      memoryVersion += 1
    case let .paused(value):
      paused = value
    case let .taskUpdated(task):
      tasks[task.id] = task
      if task.status != .running { taskProgress[task.id] = nil }
    case let .taskStep(step):
      guard var list = steps[step.taskId] else { return }
      if let i = list.firstIndex(where: { $0.id == step.id }) { list[i] = step } else { list.append(step) }
      steps[step.taskId] = list
    case let .taskProgress(taskId, text):
      taskProgress[taskId] = String(((taskProgress[taskId] ?? "") + text).suffix(400))
    case let .approvalCreated(a), let .approvalResolved(a):
      approvals[a.id] = a
    case let .desktopState(state):
      desktop = state
    case let .scheduleUpdated(s):
      schedules[s.id] = s
      deletedSchedules.remove(s.id)
    case let .scheduleDeleted(id):
      schedules[id] = nil
      deletedSchedules.insert(id)
    case let .triggerUpdated(t):
      triggers[t.id] = t
      deletedTriggers.remove(t.id)
    case let .triggerDeleted(id):
      triggers[id] = nil
      deletedTriggers.insert(id)
    case let .episodeUpdated(e):
      episodes[e.id] = e
    case .unknown:
      break
    }
  }

  // MARK: Thread

  private func upsert(_ m: ThreadMessage) {
    if let i = messages.firstIndex(where: { $0.id == m.id }) {
      messages[i] = m
    } else {
      messages.append(m)
      messages.sort { $0.id < $1.id }
    }
  }

  func loadThread() async throws {
    let list: [ThreadMessage] = try await api.get("/thread/messages?limit=\(Self.page)")
    try? await loadEpisodes(list)
    messages = list
    hasEarlier = list.count == Self.page
  }

  func loadEarlier() async throws {
    guard let first = messages.first else { return }
    let older: [ThreadMessage] = try await api.get("/thread/messages?limit=\(Self.page)&before=\(first.id)")
    try? await loadEpisodes(older)
    messages = older + messages
    hasEarlier = older.count == Self.page
  }

  /// Fetches the conversations of `list` we don't have yet. A brain from before folds answers 404.
  private func loadEpisodes(_ list: [ThreadMessage]) async throws {
    let ids = Set(list.compactMap(\.episodeId)).filter { episodes[$0] == nil }.sorted()
    guard !ids.isEmpty else { return }
    let found: [Episode] = try await api.get("/thread/episodes?ids=" + ids.map(String.init).joined(separator: ","))
    for e in found { episodes[e.id] = e }
  }

  func send(_ text: String) async throws {
    struct Body: Encodable { let text: String }
    let m: ThreadMessage = try await api.post("/thread/messages", body: Body(text: text))
    upsert(m)
  }

  // MARK: Tasks and approvals

  func loadTask(_ id: Int) async throws {
    let res: TaskWithSteps = try await api.get("/tasks/\(id)")
    tasks[id] = res.task
    steps[id] = res.steps
  }

  /// Loads a task the first time something shows it.
  func ensureTask(_ id: Int) {
    if tasks[id] != nil && steps[id] != nil { return }
    guard requested.insert("t\(id)").inserted else { return }
    Task {
      do { try await loadTask(id) } catch { requested.remove("t\(id)") }
    }
  }

  func ensureApproval(_ id: Int) {
    if approvals[id] != nil { return }
    guard requested.insert("a\(id)").inserted else { return }
    Task {
      do {
        let a: Approval = try await api.get("/approvals/\(id)")
        approvals[a.id] = a
      } catch { requested.remove("a\(id)") }
    }
  }

  func ensureSchedule(_ id: Int) {
    if schedules[id] != nil || deletedSchedules.contains(id) { return }
    guard requested.insert("s\(id)").inserted else { return }
    Task {
      do {
        let s: Schedule = try await api.get("/schedules/\(id)")
        schedules[s.id] = s
      } catch let error as APIError where error.status == 404 {
        deletedSchedules.insert(id)
      } catch { requested.remove("s\(id)") }
    }
  }

  enum TaskFilter: String {
    case active, done
  }

  /// The ids of the tasks in a list, newest first.
  func loadTasks(_ filter: TaskFilter) async throws -> [Int] {
    let list: [AgentTask] = try await api.get("/tasks?status=\(filter.rawValue)")
    for t in list { tasks[t.id] = t }
    return list.map(\.id)
  }

  /// Pending approvals and the desktop; anything we thought pending but the brain doesn't list was decided meanwhile.
  func loadLive() async throws {
    let pending: [Approval] = try await api.get("/approvals?pending=1")
    let state: DesktopState? = try? await api.get("/desktop/status")
    for a in approvals.values where a.status == .pending {
      requested.remove("a\(a.id)")
      if !pending.contains(where: { $0.id == a.id }) { approvals[a.id] = nil }
    }
    for a in pending { approvals[a.id] = a }
    desktop = state
    for t in tasks.values where steps[t.id] != nil && t.isActive {
      try? await loadTask(t.id)
    }
  }

  func decide(_ id: Int, _ decision: Decision) async throws {
    struct Body: Encodable { let decision: Decision }
    let a: Approval = try await api.post("/approvals/\(id)", body: Body(decision: decision))
    approvals[a.id] = a
  }

  func cancelTask(_ id: Int) async throws {
    try await api.post("/tasks/\(id)/cancel")
  }

  // MARK: Desktop

  func takeover() async throws {
    desktop = try await api.post("/desktop/takeover", body: Empty())
  }

  func handback() async throws {
    desktop = try await api.post("/desktop/handback", body: Empty())
  }

  /// The live view's socket: JPEG frames out, your input in while you have control.
  func liveSocket() -> Socket {
    let api = self.api
    return Socket(maxDelay: 15) { api.webSocket("/desktop/live") }
  }

  // MARK: Schedules and triggers

  /// Every schedule and trigger, for their list.
  func loadSchedules() async throws {
    async let s: [Schedule] = api.get("/schedules")
    async let t: [Trigger] = api.get("/triggers")
    let (list, hooks) = try await (s, t)
    schedules = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    triggers = Dictionary(uniqueKeysWithValues: hooks.map { ($0.id, $0) })
  }

  func loadSchedule(_ id: Int) async throws {
    schedules[id] = try await api.get("/schedules/\(id)")
  }

  func loadTrigger(_ id: Int) async throws {
    triggers[id] = try await api.get("/triggers/\(id)")
  }

  /// A change to a schedule; nil fields stay as they are. Give `cron` or `at`, not both.
  struct ScheduleChange: Encodable, Sendable {
    var name: String?
    var prompt: String?
    var enabled: Bool?
    var cron: String?
    /// ISO 8601 date and time, for a one-off run.
    var at: String?
  }

  @discardableResult
  func saveSchedule(_ id: Int, _ change: ScheduleChange) async throws -> Schedule {
    let s: Schedule = try await api.patch("/schedules/\(id)", body: change)
    schedules[s.id] = s
    return s
  }

  func createSchedule(_ change: ScheduleChange) async throws -> Schedule {
    let s: Schedule = try await api.post("/schedules", body: change)
    schedules[s.id] = s
    return s
  }

  /// Runs it now; returns the task.
  func runSchedule(_ id: Int) async throws -> AgentTask {
    let task: AgentTask = try await api.post("/schedules/\(id)/run", body: Empty())
    tasks[task.id] = task
    return task
  }

  func deleteSchedule(_ id: Int) async throws {
    let _: Empty = try await api.delete("/schedules/\(id)")
    schedules[id] = nil
    deletedSchedules.insert(id)
  }

  struct TriggerChange: Encodable, Sendable {
    var name: String?
    var prompt: String?
    var trusted: Bool?
    var enabled: Bool?
  }

  @discardableResult
  func saveTrigger(_ id: Int, _ change: TriggerChange) async throws -> Trigger {
    let t: Trigger = try await api.patch("/triggers/\(id)", body: change)
    triggers[t.id] = t
    return t
  }

  /// A new secret; the old one stops working at once.
  func newTriggerSecret(_ id: Int) async throws -> TriggerWithSecret {
    let t: TriggerWithSecret = try await api.post("/triggers/\(id)/secret", body: Empty())
    triggers[id] = t.trigger
    return t
  }

  func deleteTrigger(_ id: Int) async throws {
    let _: Empty = try await api.delete("/triggers/\(id)")
    triggers[id] = nil
    deletedTriggers.insert(id)
  }

  // MARK: Memory

  func memoryTree() async throws -> [MemoryFile] {
    try await api.get("/memory/tree")
  }

  func memoryFile(_ path: String) async throws -> String {
    struct File: Decodable { let content: String }
    let f: File = try await api.get("/memory/file?path=\(API.query(path))")
    return f.content
  }

  /// Saves a file as you; returns the commit, or nil if nothing changed.
  @discardableResult
  func saveMemoryFile(_ path: String, content: String) async throws -> String? {
    struct Body: Encodable {
      let content: String
      let message: String
    }
    struct Saved: Decodable { let sha: String? }
    let r: Saved = try await api.put(
      "/memory/file?path=\(API.query(path))", body: Body(content: content, message: "Edit \(path)"))
    memoryVersion += 1
    return r.sha
  }

  func deleteMemoryFile(_ path: String) async throws {
    let _: Empty = try await api.delete("/memory/file?path=\(API.query(path))")
    memoryVersion += 1
  }

  func memoryLog(path: String? = nil) async throws -> [MemoryCommit] {
    try await api.get("/memory/log?limit=100" + (path.map { "&path=\(API.query($0))" } ?? ""))
  }

  func memoryDiff(_ sha: String) async throws -> String {
    struct Diff: Decodable { let diff: String }
    let d: Diff = try await api.get("/memory/diff/\(sha)")
    return d.diff
  }

  /// Undoes a commit with a new one; returns it, or nil if there was nothing to undo.
  func revert(_ sha: String) async throws -> String? {
    struct Reverted: Decodable { let sha: String? }
    let r: Reverted = try await api.post("/memory/revert/\(sha)", body: Empty())
    memoryVersion += 1
    return r.sha
  }

  // MARK: Admin

  func setPaused(_ value: Bool) async throws {
    try await api.post(value ? "/pause-all" : "/resume")
    paused = value
  }

  func loadSpend() async throws -> SpendSummary {
    let s: SpendSummary = try await api.get("/spend/summary")
    todayUsd = s.todayUsd
    monthUsd = s.monthUsd
    return s
  }

  func loadSettings() async throws -> AppSettings {
    try await api.get("/settings")
  }

  func setChatEffort(_ effort: AppSettings.Effort) async throws -> AppSettings {
    struct Body: Encodable { let chatEffort: AppSettings.Effort }
    return try await api.put("/settings", body: Body(chatEffort: effort))
  }

  func setChatModel(_ model: AppSettings.ChatModel) async throws -> AppSettings {
    struct Body: Encodable { let chatModel: AppSettings.ChatModel }
    return try await api.put("/settings", body: Body(chatModel: model))
  }

  func setDesktopModel(_ model: AppSettings.DesktopModel) async throws -> AppSettings {
    struct Body: Encodable { let desktopModel: AppSettings.DesktopModel }
    return try await api.put("/settings", body: Body(desktopModel: model))
  }

  func setNotificationsOpen(_ opens: AppSettings.Opens) async throws -> AppSettings {
    struct Body: Encodable { let notificationsOpen: AppSettings.Opens }
    return try await api.put("/settings", body: Body(notificationsOpen: opens))
  }
}
