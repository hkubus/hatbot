// Live client state: the thread, tasks, approvals, the desktop, pause state and spend, fed by
// the event stream. Same shape as apps/web/src/store.ts.
import Foundation
import Observation

@MainActor
@Observable
final class AppStore {
  static let page = 50

  var messages: [ThreadMessage] = []
  /// Latest progress note per streaming reply.
  var progress: [Int: String] = [:]
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
    case let .messageDone(id, text, status):
      progress[id] = nil
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
    messages = list
    hasEarlier = list.count == Self.page
  }

  func loadEarlier() async throws {
    guard let first = messages.first else { return }
    let older: [ThreadMessage] = try await api.get("/thread/messages?limit=\(Self.page)&before=\(first.id)")
    messages = older + messages
    hasEarlier = older.count == Self.page
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
}
