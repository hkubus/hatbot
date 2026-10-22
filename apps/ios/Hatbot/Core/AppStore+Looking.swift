// These screens load what they show when they open, without live events.
import Foundation

extension AppStore {
  func search(_ query: String) async throws -> SearchResults {
    try await api.get("/search?q=" + API.query(query))
  }

  @discardableResult
  func loadWatchers() async throws -> [Watcher] {
    let list: [Watcher] = try await api.get("/watchers")
    watchers = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    watchersLoaded = true
    return list
  }

  @discardableResult
  func loadWatcher(_ id: Int) async throws -> Watcher {
    keep(try await api.get("/watchers/\(id)"))
  }

  private func keep(_ w: Watcher) -> Watcher {
    watchers[w.id] = w
    return w
  }

  func watcherValues(_ id: Int) async throws -> [WatcherValue] {
    try await api.get("/watchers/\(id)/values")
  }

  func setWatcherEnabled(_ id: Int, _ on: Bool) async throws -> Watcher {
    struct Body: Encodable { let enabled: Bool }
    return keep(try await api.patch("/watchers/\(id)", body: Body(enabled: on)))
  }

  /// The brain reads the page again before it saves this.
  func setWatcherRender(_ id: Int, _ on: Bool) async throws -> Watcher {
    guard let w = watchers[id] else { throw APIError(status: 404, message: "This watcher doesn't exist.") }
    return keep(try await api.patch("/watchers/\(id)", body: w.render(on), timeout: API.watcherTimeout))
  }

  func checkWatcher(_ id: Int) async throws -> Watcher {
    keep(try await api.post("/watchers/\(id)/check", body: Empty(), timeout: API.watcherTimeout))
  }

  func deleteWatcher(_ id: Int) async throws {
    let _: Empty = try await api.delete("/watchers/\(id)")
    watchers[id] = nil
    deletedWatchers.insert(id)
  }

  func loadChecks() async throws -> ChecksInfo {
    let info: ChecksInfo = try await api.get("/checks")
    if let a = info.approval { approvals[a.id] = a }
    return info
  }

  func runChecks() async throws -> CheckReport {
    try await api.post("/checks", body: Empty(), timeout: API.checksTimeout)
  }

  func loadHeartbeat() async throws -> HeartbeatInfo {
    try await api.get("/heartbeat")
  }

  func runHeartbeat() async throws -> HeartbeatInfo {
    try await api.post("/heartbeat/run", body: Empty())
  }

  /// Nil when the Self plugin isn't set up.
  func loadCodeSuggestions() async -> CodeSuggestions? {
    let r: ActionResult<CodeSuggestions>? = try? await api.post("/plugins/self/actions/suggestions", body: Empty())
    return r?.result
  }

  func setCodeSuggestions(_ every: String) async throws -> CodeSuggestions {
    struct Body: Encodable { let every: String }
    let r: ActionResult<CodeSuggestions> = try await api.post("/plugins/self/actions/suggest", body: Body(every: every))
    return r.result
  }

  private struct ActionResult<T: Decodable & Sendable>: Decodable, Sendable { let result: T }

  func sendReport() async throws -> String {
    struct Sent: Decodable { let text: String }
    let r: Sent = try await api.post("/report/send", body: Empty())
    return r.text
  }

  func loadProposals() async throws {
    let list: [Proposal] = try await api.get("/proposals?status=pending")
    proposals = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
  }

  var pendingProposals: [Proposal] {
    proposals.values.filter { $0.status == .pending }.sorted { $0.id < $1.id }
  }

  /// Asks for a tidy-up. The brain answers at once and the proposal comes as proposal.updated; a brain
  /// from before answers with it, or nothing when there's nothing to tidy.
  func proposeTidy() async throws -> ProposalStarted {
    try await api.post("/proposals/tidy", body: Empty())
  }

  func applyProposal(_ id: Int) async throws -> Proposal {
    let p: Proposal = try await api.post("/proposals/\(id)/apply", body: Empty())
    proposals[p.id] = p
    memoryVersion += 1
    return p
  }

  func dismissProposal(_ id: Int) async throws -> Proposal {
    let p: Proposal = try await api.post("/proposals/\(id)/dismiss", body: Empty())
    proposals[p.id] = p
    return p
  }

  func loadSkills() async throws -> [SkillStatus] {
    try await api.get("/skills")
  }

  func proposeSkillFix(_ name: String) async throws -> ProposalStarted {
    try await api.post("/skills/\(API.query(name))/fix", body: Empty())
  }

  func rerunTask(_ id: Int, goal: String?) async throws -> AgentTask {
    struct Body: Encodable { let goal: String? }
    let task: AgentTask = try await api.post("/tasks/\(id)/rerun", body: Body(goal: goal))
    tasks[task.id] = task
    return task
  }
}
