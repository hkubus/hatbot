// Search, watchers, Check everything, the heartbeat and weekly report, proposals, and running a
// task again. These screens load what they show when they open, without live events.
import Foundation

extension AppStore {
  func search(_ query: String) async throws -> SearchResults {
    try await api.get("/search?q=" + API.query(query))
  }

  // MARK: Watchers

  func loadWatchers() async throws -> [Watcher] {
    try await api.get("/watchers")
  }

  func loadWatcher(_ id: Int) async throws -> Watcher {
    try await api.get("/watchers/\(id)")
  }

  func watcherValues(_ id: Int) async throws -> [WatcherValue] {
    try await api.get("/watchers/\(id)/values")
  }

  func setWatcherEnabled(_ id: Int, _ on: Bool) async throws -> Watcher {
    struct Body: Encodable { let enabled: Bool }
    return try await api.patch("/watchers/\(id)", body: Body(enabled: on))
  }

  /// Looks now; the watcher as it is after.
  func checkWatcher(_ id: Int) async throws -> Watcher {
    try await api.post("/watchers/\(id)/check", body: Empty())
  }

  func deleteWatcher(_ id: Int) async throws {
    let _: Empty = try await api.delete("/watchers/\(id)")
  }

  // MARK: Check everything

  func loadChecks() async throws -> CheckReport? {
    let info: ChecksInfo = try await api.get("/checks")
    return info.report
  }

  func runChecks() async throws -> CheckReport {
    try await api.post("/checks", body: Empty())
  }

  // MARK: Heartbeat and weekly report

  func loadHeartbeat() async throws -> HeartbeatInfo {
    try await api.get("/heartbeat")
  }

  func runHeartbeat() async throws -> HeartbeatInfo {
    try await api.post("/heartbeat/run", body: Empty())
  }

  /// Sends the week's report now; its text.
  func sendReport() async throws -> String {
    struct Sent: Decodable { let text: String }
    let r: Sent = try await api.post("/report/send", body: Empty())
    return r.text
  }

  func setHeartbeat(_ value: AppSettings.Heartbeat) async throws -> AppSettings {
    struct Body: Encodable { let heartbeat: AppSettings.Heartbeat }
    return try await api.put("/settings", body: Body(heartbeat: value))
  }

  func setWeeklyReport(_ value: AppSettings.WeeklyReport) async throws -> AppSettings {
    struct Body: Encodable { let weeklyReport: AppSettings.WeeklyReport }
    return try await api.put("/settings", body: Body(weeklyReport: value))
  }

  func setMemoryTidy(_ on: Bool) async throws -> AppSettings {
    struct Body: Encodable { let memoryTidy: Bool }
    return try await api.put("/settings", body: Body(memoryTidy: on))
  }

  // MARK: Proposals

  func loadProposals() async throws -> [Proposal] {
    try await api.get("/proposals?status=pending")
  }

  /// Asks for a tidy-up now; nil when there's nothing to tidy.
  func proposeTidy() async throws -> Proposal? {
    try await api.post("/proposals/tidy", body: Empty())
  }

  func applyProposal(_ id: Int) async throws -> Proposal {
    let p: Proposal = try await api.post("/proposals/\(id)/apply", body: Empty())
    memoryVersion += 1
    return p
  }

  func dismissProposal(_ id: Int) async throws -> Proposal {
    let p: Proposal = try await api.post("/proposals/\(id)/dismiss", body: Empty())
    // The memory screen lists what's left.
    memoryVersion += 1
    return p
  }

  func loadSkills() async throws -> [SkillStatus] {
    try await api.get("/skills")
  }

  /// Asks for a fix to a skill; nil when Hatbot found nothing to change.
  func proposeSkillFix(_ name: String) async throws -> Proposal? {
    try await api.post("/skills/\(API.query(name))/fix", body: Empty())
  }

  // MARK: Tasks

  /// Starts an ended task anew, with its goal as given; the new task.
  func rerunTask(_ id: Int, goal: String?) async throws -> AgentTask {
    struct Body: Encodable { let goal: String? }
    let task: AgentTask = try await api.post("/tasks/\(id)/rerun", body: Body(goal: goal))
    tasks[task.id] = task
    return task
  }
}
