// The thread (PLAN.md §10.2, §10.4): plain bubbles, a time under each, Copy and Open in a long-press
// menu. A task shows under the reply that started it; approvals carry Approve and Deny. Finished
// conversations fold up under their recap.
import SwiftUI
import UIKit

struct ChatView: View {
  @Environment(AppStore.self) private var store
  @State private var path: [Route] = []
  @State private var draft = ""
  @State private var sending = false
  @State private var error: String?
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var loaded = false
  @State private var unfolded = Set<Int>()

  /// What the list shows: day labels, folds, and the messages that aren't folded away.
  private enum Row: Identifiable {
    case day(String, before: Int)
    case fold(ThreadGroup)
    case message(ThreadMessage)

    var id: String {
      switch self {
      case let .day(_, before): "d\(before)"
      case let .fold(g): "f\(g.id)"
      case let .message(m): "m\(m.id)"
      }
    }
  }

  private var rows: [Row] {
    var rows: [Row] = []
    var previous: ThreadMessage?
    func add(_ m: ThreadMessage, as row: Row) {
      if let day = dayChange(m, after: previous) { rows.append(.day(day, before: m.id)) }
      previous = m
      rows.append(row)
    }
    for g in ThreadFolds.groups(store.messages, episodes: store.episodes) {
      guard g.fold != nil, let id = g.episodeId else {
        for m in g.messages { add(m, as: .message(m)) }
        continue
      }
      add(g.messages[0], as: .fold(g))
      // An approval still waiting for you stays in view.
      let shown = unfolded.contains(id)
        ? g.messages
        : g.messages.filter { m in m.approvalId.map { store.approvals[$0]?.status == .pending } ?? false }
      for m in shown { add(m, as: .message(m)) }
    }
    return rows
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(spacing: 14) {
          if store.hasEarlier {
            Button("Earlier messages") { Task { try? await store.loadEarlier() } }
              .buttonStyle(.borderless)
              .font(.subheadline)
          }
          if loaded && store.messages.isEmpty {
            Text("Say hello to Hatbot.").foregroundStyle(.secondary).padding(.top, 40)
          }
          ForEach(rows) { row in
            switch row {
            case let .day(day, _):
              Text(day).font(.footnote.weight(.medium)).foregroundStyle(.secondary).padding(.top, 6)
            case let .fold(g):
              FoldRow(group: g, open: g.episodeId.map { unfolded.contains($0) } ?? false) {
                guard let id = g.episodeId else { return }
                withAnimation(.snappy) {
                  if unfolded.remove(id) == nil { unfolded.insert(id) }
                }
              }
            case let .message(m):
              MessageRow(m: m, open: { path.append($0) })
            }
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
      }
      .scrollPosition($position)
      .defaultScrollAnchor(.bottom)
      .defaultScrollAnchor(.bottom, for: .sizeChanges)
      .scrollDismissesKeyboard(.interactively)
      .edgeBar(.top) {
        if store.paused { PausedBanner() }
      }
      .edgeBar(.bottom) { composer }
      .navigationTitle("Hatbot")
      .navigationBarTitleDisplayMode(.inline)
      .routes()
      .task {
        do {
          try await store.loadThread()
        } catch {
          self.error = message(for: error)
        }
        loaded = true
      }
    }
  }

  /// "Today", "Yesterday" or the date, when a message starts a new day.
  private func dayChange(_ m: ThreadMessage, after previous: ThreadMessage?) -> String? {
    guard let date = Format.date(m.createdAt) else { return nil }
    if let prev = Format.date(previous?.createdAt),
      Calendar.current.isDate(prev, inSameDayAs: date)
    {
      return nil
    }
    if Calendar.current.isDateInToday(date) { return "Today" }
    if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
    let thisYear = Calendar.current.isDate(date, equalTo: .now, toGranularity: .year)
    return thisYear
      ? date.formatted(.dateTime.weekday(.wide).day().month(.wide))
      : date.formatted(.dateTime.weekday(.wide).day().month(.wide).year())
  }

  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending
  }

  private var composer: some View {
    VStack(spacing: 6) {
      if let error {
        Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message Hatbot…", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .padding(.horizontal, 16)
          .padding(.vertical, 11)
          .glassSurface(in: .rect(cornerRadius: 22), interactive: true)
        Button(action: send) {
          Image(systemName: "arrow.up")
            .font(.body.weight(.semibold))
            .frame(width: 26, height: 30)
        }
        .glassButton(prominent: true)
        .buttonBorderShape(.circle)
        .tint(.brand)
        .disabled(!canSend)
        .accessibilityLabel("Send")
      }
      .glassGroup(spacing: 8)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    sending = true
    error = nil
    Task {
      do {
        try await store.send(text)
        draft = ""
        withAnimation { position.scrollTo(edge: .bottom) }
      } catch {
        self.error = "Couldn't send. Check your connection and try again."
      }
      sending = false
    }
  }
}

struct PausedBanner: View {
  @Environment(AppStore.self) private var store

  var body: some View {
    HStack {
      Label("All activity is paused.", systemImage: "pause.circle.fill")
      Spacer()
      Button("Resume") { Task { try? await store.setPaused(false) } }
        .buttonStyle(.borderless)
        .fontWeight(.semibold)
    }
    .font(.subheadline)
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .glassSurface(in: .capsule)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }
}

/// A finished conversation, folded up under its recap; a tap opens it in place.
private struct FoldRow: View {
  let group: ThreadGroup
  let open: Bool
  let toggle: () -> Void

  var body: some View {
    Button(action: toggle) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .rotationEffect(.degrees(open ? 90 : 0))
        Text(group.fold ?? "")
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(group.messages[0].createdAt.timeText).font(.caption2)
      }
      .font(.subheadline)
      .foregroundStyle(.secondary)
      .padding(.vertical, 6)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityHint(open ? "Folds the conversation" : "Shows the conversation")
  }
}

// MARK: Messages

private struct MessageRow: View {
  let m: ThreadMessage
  let open: (Route) -> Void
  @Environment(AppStore.self) private var store

  var body: some View {
    if m.role == .user {
      VStack(alignment: .trailing, spacing: 4) {
        Text(m.text)
          .textSelection(.enabled)
          .padding(.horizontal, 13)
          .padding(.vertical, 8)
          .background(Color.userBubble, in: UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18))
          .contextMenu { copyButton(m.text) }
        Text(m.createdAt.timeText).font(.caption2).foregroundStyle(.secondary)
      }
      .padding(.leading, 48)
      .frame(maxWidth: .infinity, alignment: .trailing)
    } else {
      VStack(alignment: .leading, spacing: 4) {
        VStack(alignment: .leading, spacing: 8) { content }
          .padding(.horizontal, 13)
          .padding(.vertical, 8)
          .background(Color.botBubble, in: UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 6, bottomTrailingRadius: 18, topTrailingRadius: 18))
          .contextMenu { menu }
        if m.status != .streaming {
          Text(m.createdAt.timeText).font(.caption2).foregroundStyle(.secondary)
        }
      }
      .padding(.trailing, 32)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private var content: some View {
    switch m.kind {
    case .task where m.taskId != nil: TaskMessage(taskId: m.taskId!)
    case .approval where m.approvalId != nil: ApprovalMessage(approvalId: m.approvalId!)
    case .schedule where m.scheduleId != nil: ScheduleMessage(scheduleId: m.scheduleId!)
    default: ReplyMessage(m: m)
    }
  }

  /// What Copy copies, and what Open opens.
  @ViewBuilder
  private var menu: some View {
    switch m.kind {
    case .approval:
      if let id = m.approvalId, let a = store.approvals[id] {
        copyButton(a.summary)
        if let taskId = a.taskId { openButton(taskId) }
      }
    case .schedule:
      if let id = m.scheduleId, let s = store.schedules[id] {
        copyButton(s.prompt)
        Button("Open schedule", systemImage: "chevron.right") { open(.schedule(id)) }
      }
    default:
      let task = m.taskId.flatMap { store.tasks[$0] }
      let result = task.flatMap { $0.isActive ? nil : $0.summary }
      if m.kind == .task {
        if let task { copyButton(result ?? task.title) }
      } else {
        copyButton([m.text, result ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n"))
      }
      if let taskId = m.taskId { openButton(taskId) }
    }
  }

  private func copyButton(_ text: String) -> some View {
    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
  }

  private func openButton(_ taskId: Int) -> some View {
    Button("Open task", systemImage: "chevron.right") { open(.task(taskId)) }
  }
}

/// A reply, with the task it started (if any) working and then reporting under it.
private struct ReplyMessage: View {
  let m: ThreadMessage
  @Environment(AppStore.self) private var store

  var body: some View {
    if !m.text.isEmpty { MarkdownText(text: m.text) }
    if m.status == .streaming && m.text.isEmpty && m.taskId == nil { TypingDots() }
    if m.status == .streaming, let note = Format.lastLine(store.progress[m.id]) {
      Text(note).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
    }
    if m.status == .streaming, let used = store.usage[m.id] {
      Text("\(Format.tokens(used.tokens)) tokens · \(String(format: "$%.3f", used.costUsd))")
        .font(.footnote.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    if let taskId = m.taskId { TaskResult(taskId: taskId) }
  }
}

/// A task under the reply that started it: working dots, then how it ended.
private struct TaskResult: View {
  let taskId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let task = store.tasks[taskId] {
        if task.isActive {
          let note = runningNote(task)
          TypingDots()
          if note != "Working…" {
            Text(note).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
          }
        } else if task.status == .done {
          MarkdownText(text: task.summary ?? "Done.")
        } else if task.status == .failed {
          MarkdownText(text: "**Didn't finish.** \(task.summary ?? "")")
        } else {
          Text("Cancelled.").foregroundStyle(.secondary)
        }
      }
    }
    .onAppear { store.ensureTask(taskId) }
  }

  private func runningNote(_ task: AgentTask) -> String {
    store.desktop?.control == .owner && task.status == .running
      ? "Paused while you have control."
      : Format.taskLine(task, progress: store.taskProgress[taskId])
  }
}

/// A background task (schedule, trigger), as a message: what it's doing, then how it ended.
private struct TaskMessage: View {
  let taskId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let task = store.tasks[taskId] {
        MarkdownText(text: text(task))
        if task.isActive {
          Text(note(task)).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
        }
      }
    }
    .onAppear { store.ensureTask(taskId) }
  }

  private func text(_ task: AgentTask) -> String {
    if task.isActive { return "**\(task.title)**" }
    switch task.status {
    case .done: return "**\(task.title)**\n\n\(task.summary ?? "Done.")"
    case .failed: return "**\(task.title)** didn't finish." + (task.summary.map { "\n\n\($0)" } ?? "")
    default: return "**\(task.title)** was cancelled."
    }
  }

  private func note(_ task: AgentTask) -> String {
    store.desktop?.control == .owner && task.status == .running
      ? "Paused while you have control."
      : Format.taskLine(task, progress: store.taskProgress[taskId])
  }
}

/// An approval, as a message with Approve and Deny under it; one line once it's answered.
private struct ApprovalMessage: View {
  let approvalId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let a = store.approvals[approvalId] {
        if a.status == .pending {
          ApprovalBody(approval: a)
        } else {
          Text("\(a.status.word): \(a.summary)").foregroundStyle(.secondary)
        }
      }
    }
    .onAppear { store.ensureApproval(approvalId) }
  }
}

/// What Hatbot wants to do and why, the page it read, a screenshot, then Deny and Approve.
struct ApprovalBody: View {
  let approval: Approval
  @Environment(AppStore.self) private var store
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    let a = approval
    let text = [
      "**Can I go ahead?** \(a.summary)",
      a.reason,
      a.sources.isEmpty ? "" : "_After reading \(a.sources.joined(separator: ", "))_",
    ].filter { !$0.isEmpty }.joined(separator: "\n\n")
    MarkdownText(text: text)
    if let taskId = a.taskId, let stepId = a.screenshotStepId {
      Screenshot(taskId: taskId, stepId: stepId)
    }
    if let error {
      Text(error).font(.footnote).foregroundStyle(.red)
    }
    HStack {
      Button("Deny", role: .destructive) { decide(.deny) }
        .glassButton()
      Button("Approve") { decide(.approve) }
        .glassButton(prominent: true)
        .tint(.attention)
    }
    .controlSize(.small)
    .disabled(busy)
  }

  private func decide(_ decision: Decision) {
    busy = true
    error = nil
    Task {
      do {
        try await store.decide(approval.id, decision)
      } catch {
        self.error = message(for: error)
        busy = false
      }
    }
  }
}

extension Approval.Status {
  var word: String {
    switch self {
    case .pending: "Pending"
    case .approved: "Approved"
    case .denied: "Denied"
    case .expired: "Expired"
    case .cancelled: "Cancelled"
    }
  }
}

/// A schedule Hatbot made, as one line.
private struct ScheduleMessage: View {
  let scheduleId: Int
  @Environment(AppStore.self) private var store

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let s = store.schedules[scheduleId] {
        let when = Format.when(cron: s.cron, runAt: s.runAt)
        MarkdownText(text: "Scheduled **\(s.name)**: \(when.prefix(1).lowercased() + when.dropFirst()).")
      } else if store.deletedSchedules.contains(scheduleId) {
        Text("Made a schedule that's since been deleted.")
      }
    }
    .onAppear { store.ensureSchedule(scheduleId) }
  }
}
