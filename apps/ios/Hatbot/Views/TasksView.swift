// Tasks: what needs you first, then Active or Finished. A task's page has its approvals, the live
// view while it uses the screen, details and the timeline.
import SwiftUI

struct TasksView: View {
  @Binding var path: [Route]
  @Environment(AppStore.self) private var store
  @State private var filter = AppStore.TaskFilter.active
  @State private var finishedIds: [Int]?
  @State private var error: String?

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let request = store.desktop?.request {
          Section {
            NavigationLink(value: Route.live(taskId: request.taskId)) {
              Label {
                Text("**Hatbot needs you:** \(request.reason)")
              } icon: {
                Image(systemName: "hand.raised.fill").foregroundStyle(Color.attention)
              }
            }
          }
        }
        ForEach(store.pendingApprovals) { a in
          Section {
            VStack(alignment: .leading, spacing: 10) { ApprovalBody(approval: a) }
              .padding(.vertical, 4)
            if let taskId = a.taskId {
              NavigationLink("Task", value: Route.task(taskId))
            }
          }
        }
        Section {
          if let error {
            Text(error).foregroundStyle(.red)
          } else if shown.isEmpty && (filter == .active || finishedIds != nil) {
            Text(filter == .active ? "Nothing running." : "No tasks yet.").foregroundStyle(.secondary)
          }
          ForEach(shown) { t in
            NavigationLink(value: Route.task(t.id)) { TaskRow(task: t) }
          }
        }
      }
      .navigationTitle("Tasks")
      .sidebarButton()
      .toolbar {
        ToolbarItem(placement: .principal) {
          Picker("Tasks", selection: $filter) {
            Text("Active").tag(AppStore.TaskFilter.active)
            Text("Finished").tag(AppStore.TaskFilter.done)
          }
          .pickerStyle(.segmented)
          .fixedSize()
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      .refreshable { await load() }
      .task(id: filter) { await load() }
      .routes()
    }
  }

  /// Tasks that start or finish while the list is open move between the two lists.
  private var shown: [AgentTask] {
    store.tasks.values
      .filter { filter == .active ? $0.isActive : !$0.isActive && (finishedIds?.contains($0.id) ?? false) }
      .sorted { $0.id > $1.id }
  }

  private func load() async {
    error = nil
    do {
      let ids = try await store.loadTasks(filter)
      if filter == .done { finishedIds = ids }
    } catch {
      self.error = message(for: error)
    }
  }
}

private struct TaskRow: View {
  let task: AgentTask

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(task.title).lineLimit(2)
      HStack(spacing: 6) {
        Text(Format.statusLabel(task.status)).foregroundStyle(task.status.tint)
        Text((task.startedAt ?? task.createdAt).stampText).foregroundStyle(.secondary)
      }
      .font(.footnote)
    }
  }
}

struct TaskDetailView: View {
  let taskId: Int
  @Environment(AppStore.self) private var store
  @State private var missing = false
  @State private var watch = false
  @State private var confirmCancel = false
  @State private var rerunGoal: String?
  @State private var rerun: Int?
  @State private var error: String?

  var body: some View {
    Group {
      if let task = store.tasks[taskId] {
        content(task)
      } else if missing {
        ContentUnavailableView("This task doesn't exist.", systemImage: "questionmark.circle")
      } else {
        ProgressView()
      }
    }
    .navigationBarTitleDisplayMode(.inline)
    .task(id: taskId) {
      do {
        try await store.loadTask(taskId)
      } catch let error as APIError where error.status == 404 {
        missing = true
      } catch {
        self.error = message(for: error)
      }
    }
  }

  private func content(_ task: AgentTask) -> some View {
    let pending = store.pendingApprovals.filter { $0.taskId == taskId }
    let screen = task.lane == .screen && task.isActive
    let showLive = screen && (watch || store.desktop?.request?.taskId == taskId)
    return List {
      if let error {
        Text(error).foregroundStyle(.red)
      }
      ForEach(pending) { a in
        Section {
          VStack(alignment: .leading, spacing: 10) { ApprovalBody(approval: a) }.padding(.vertical, 4)
        }
      }
      if showLive {
        Section { LiveView(taskId: taskId, showsTask: false) }
          .listRowInsets(EdgeInsets())
      }
      Section {
        VStack(alignment: .leading, spacing: 6) {
          Text(task.title).font(.title3.bold())
          Text(Format.statusLabel(task.status)).font(.subheadline).foregroundStyle(task.status.tint)
        }
        .padding(.vertical, 2)
        if task.isActive {
          Text(Format.taskLine(task, progress: store.taskProgress[taskId])).foregroundStyle(.secondary)
        } else if let summary = task.summary {
          MarkdownText(text: summary)
        }
        DisclosureGroup("Details") { TaskDetails(task: task) }
      }
      Section("Timeline") {
        let steps = (store.steps[taskId] ?? []).latestNoteOnly
        if steps.isEmpty {
          Text(task.isActive ? "Hasn't started yet." : "No steps.").foregroundStyle(.secondary)
        }
        ForEach(steps) { step in StepRow(step: step) }
      }
    }
    .scrollDisabled(showLive && store.desktop?.control == .owner)
    .toolbar {
      if screen && !showLive {
        ToolbarItem { Button("Watch", systemImage: "display") { watch = true } }
      }
      if task.isActive {
        ToolbarItem {
          Button("Cancel task", role: .destructive) { confirmCancel = true }
        }
      } else if task.lane == .background && task.parentId == nil {
        ToolbarItem { Button("Run again", systemImage: "arrow.clockwise") { rerunGoal = task.goal } }
      }
    }
    .sheet(item: Binding(get: { rerunGoal.map(Goal.init) }, set: { rerunGoal = $0?.text })) { _ in
      NavigationStack {
        Form {
          TextField("Goal", text: Binding(get: { rerunGoal ?? "" }, set: { rerunGoal = $0 }), axis: .vertical)
            .lineLimit(4...16)
        }
        .navigationTitle("Run again")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { rerunGoal = nil } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Run") {
              let goal = rerunGoal?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
              rerunGoal = nil
              Task {
                do {
                  rerun = try await store.rerunTask(taskId, goal: goal == task.goal ? nil : goal).id
                } catch {
                  self.error = message(for: error)
                }
              }
            }
            .disabled((rerunGoal ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
      }
    }
    .navigationDestination(item: $rerun) { id in TaskDetailView(taskId: id) }
    .confirmationDialog("Cancel “\(task.title)”?", isPresented: $confirmCancel, titleVisibility: .visible) {
      Button("Cancel task", role: .destructive) {
        Task {
          do { try await store.cancelTask(taskId) } catch { self.error = message(for: error) }
        }
      }
      Button("Keep running", role: .cancel) {}
    }
  }
}

/// The goal being edited before a task runs again.
private struct Goal: Identifiable {
  let text: String
  var id: Int { 0 }
}

private struct TaskDetails: View {
  let task: AgentTask

  var body: some View {
    LabeledContent("From") {
      if let parent = task.parentId {
        NavigationLink("Task #\(parent)", value: Route.task(parent))
      } else {
        Text(task.origin == .chat ? "Chat" : task.source ?? "")
      }
    }
    LabeledContent("Goal") { Text(task.goal).multilineTextAlignment(.trailing) }
    if !task.successCriteria.isEmpty {
      LabeledContent("Done when") { Text(task.successCriteria).multilineTextAlignment(.trailing) }
    }
    LabeledContent("Started", value: task.startedAt?.stampText ?? "–")
    LabeledContent("Model", value: task.model)
    LabeledContent("Trust") {
      if task.injectionSuspected {
        Label("Possible prompt injection", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
      } else {
        Text(
          task.tainted
            ? (task.lane == .screen ? "Read web pages" : "Read untrusted content") : "Trusted sources only")
      }
    }
    if let taintedBy = task.taintedBy {
      LabeledContent("Tainted by") { Text(taintedBy).multilineTextAlignment(.trailing) }
    }
    LabeledContent("Cost", value: Format.money(task.costUsd))
    if let report = task.reportPath {
      NavigationLink(value: Route.memoryFile(report)) { LabeledContent("Report", value: report) }
    }
    if let payload = task.payload {
      VStack(alignment: .leading, spacing: 6) {
        Text("Event")
        ScrollView(.horizontal) {
          Text(payload).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }
      }
    }
  }
}

private struct StepRow: View {
  let step: TaskStep

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: icon)
        .foregroundStyle(step.kind == .approval || step.kind == .takeover ? Color.attention : .secondary)
        .frame(width: 20)
      VStack(alignment: .leading, spacing: 6) {
        if step.kind == .task, let id = step.url.flatMap({ Int($0.split(separator: "/").last ?? "") }) {
          NavigationLink(step.name, value: Route.task(id))
        } else {
          Text(step.detail.isEmpty || step.kind == .note ? step.name : step.detail)
        }
        if step.kind == .note && !step.detail.isEmpty {
          Text(step.detail).foregroundStyle(.secondary)
        }
        if step.kind == .page, let url = step.url.flatMap(URL.init(string:)) {
          Link(url.host() ?? url.absoluteString, destination: url).font(.footnote)
        }
        if step.screenshot != nil {
          Screenshot(taskId: step.taskId, stepId: step.id)
        }
        Text(step.createdAt.timeText).font(.caption2).foregroundStyle(.secondary)
      }
    }
    .font(.subheadline)
  }

  private var icon: String {
    switch step.kind {
    case .action where step.name.hasPrefix("memory_"): "book"
    case .action where step.name == "search_history": "text.bubble"
    case .note: "text.bubble"
    case .action: "cursorarrow.click"
    case .screenshot, .task: "display"
    case .page: "globe"
    case .approval: "checkmark.shield"
    case .takeover: "hand.raised"
    case .error: "exclamationmark.triangle"
    }
  }
}
