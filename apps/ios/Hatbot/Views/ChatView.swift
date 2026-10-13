// The thread (PLAN.md §10.2, §10.4): Messages-style bubbles, grouped by sender with a tail on the
// last, a centered time after a pause, Copy and Open in a long-press menu. A task shows under the reply
// that started it; approvals wait above the composer. Finished conversations fold up under their recap.
import PhotosUI
import SwiftUI
import UIKit

struct ChatView: View {
  @Environment(AppStore.self) private var store
  @State private var path: [Route] = []
  @State private var draft = ""
  @State private var files: [ComposerFile] = []
  @State private var photos: [PhotosPickerItem] = []
  @State private var pickingPhotos = false
  @State private var pickingFiles = false
  @State private var sending = false
  @State private var error: String?
  @State private var position = ScrollPosition(edge: .bottom)
  @State private var loaded = false
  @State private var unfolded = Set<Int>()
  private var name: String { store.chatName(store.currentChat) }
  @State private var farFromBottom = false

  /// What the list shows: times, folds, and the messages that aren't folded away.
  private enum Row: Identifiable {
    case time(String, before: Int)
    case fold(ThreadGroup)
    /// `joined`: it follows a message from the same sender; `tail`: it's the last of them.
    case message(ThreadMessage, joined: Bool = false, tail: Bool = true)

    var id: String {
      switch self {
      case let .time(_, before): "t\(before)"
      case let .fold(g): "f\(g.id)"
      case let .message(m, _, _): "m\(m.id)"
      }
    }
  }

  private var rows: [Row] {
    var rows: [Row] = []
    var previous: ThreadMessage?
    func add(_ m: ThreadMessage, as row: Row) {
      if let time = pause(m, after: previous) { rows.append(.time(time, before: m.id)) }
      previous = m
      rows.append(row)
    }
    func add(_ m: ThreadMessage) { add(m, as: .message(m)) }
    for g in ThreadFolds.groups(store.messages, episodes: store.episodes) {
      guard g.fold != nil, let id = g.episodeId else {
        for m in g.messages { add(m) }
        continue
      }
      add(g.messages[0], as: .fold(g))
      // A message you haven't seen stays in view.
      let shown = unfolded.contains(id) ? g.messages : g.messages.filter { store.unread.contains($0.id) }
      for m in shown { add(m) }
    }
    return grouped(rows)
  }

  /// Runs of messages from the same sender sit close together, with a tail on the last.
  private func grouped(_ rows: [Row]) -> [Row] {
    func sender(_ row: Row?) -> ThreadMessage.Role? {
      if case let .message(m, _, _)? = row, !m.isNote { m.role } else { nil }
    }
    return rows.indices.map { i in
      guard case let .message(m, _, _) = rows[i] else { return rows[i] }
      let before = i > 0 ? rows[i - 1] : nil
      let after = i + 1 < rows.count ? rows[i + 1] : nil
      return .message(m, joined: sender(before) == m.role, tail: sender(after) != m.role)
    }
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        LazyVStack(spacing: 0) {
          // Scrolling up to the top loads the page before it; the bottom anchor keeps your place.
          if store.hasEarlier {
            ProgressView()
              .padding(.vertical, 8)
              .task(id: store.messages.first?.id) { try? await store.loadEarlier() }
          }
          if loaded && store.messages.isEmpty {
            Text(
              store.incognito
                ? "\(name) can't see earlier conversations here, and this one is deleted when you leave."
                : "Say hello to \(name)."
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.top, 40)
          }
          ForEach(rows) { row in
            switch row {
            case let .time(time, _):
              Text(time).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                .padding(.top, 14)
                .padding(.bottom, 4)
            case let .fold(g):
              FoldRow(group: g, open: g.episodeId.map { unfolded.contains($0) } ?? false) {
                guard let id = g.episodeId else { return }
                withAnimation(.snappy) {
                  if unfolded.remove(id) == nil { unfolded.insert(id) }
                }
              }
              .padding(.top, 10)
            case let .message(m, joined, tail):
              MessageRow(m: m, tail: tail, open: { path.append($0) })
                .padding(.top, joined ? 2 : 10)
            }
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
      }
      .scrollPosition($position)
      .defaultScrollAnchor(.bottom)
      .defaultScrollAnchor(.bottom, for: .sizeChanges)
      .onScrollGeometryChange(for: Bool.self) { geo in
        geo.contentSize.height - geo.visibleRect.maxY > 400
      } action: { _, far in
        withAnimation(.snappy) { farFromBottom = far }
      }
      .overlay(alignment: .bottom) {
        if farFromBottom {
          Button {
            withAnimation { position.scrollTo(edge: .bottom) }
          } label: {
            Image(systemName: "arrow.down")
              .font(.body.weight(.semibold))
              .frame(width: 26, height: 30)
          }
          .glassButton()
          .buttonBorderShape(.circle)
          .padding(.bottom, 8)
          .transition(.scale.combined(with: .opacity))
          .accessibilityLabel("Scroll to bottom")
        }
      }
      .scrollDismissesKeyboard(.interactively)
      .edgeBar(.top) {
        if store.paused { PausedBanner() }
      }
      .edgeBar(.bottom) { composer }
      .navigationTitle(store.incognito ? "Incognito" : name)
      .sidebarButton()
      .toolbar {
        if let bot = store.currentChat.flatMap({ $0.kind == .direct ? $0.botIds.first : nil }) {
          ToolbarItem(placement: .topBarTrailing) {
            NavigationLink(value: Route.bot(bot)) { Image(systemName: "slider.horizontal.3") }
              .accessibilityLabel("About \(name)")
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          // Leaving deletes the incognito conversation.
          Button {
            Task { await store.setIncognito(!store.incognito) }
          } label: {
            Image(systemName: "eyeglasses")
              .foregroundStyle(store.incognito ? Color.accentColor : Color.primary)
          }
          .accessibilityLabel(store.incognito ? "Leave incognito" : "Incognito")
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      .routes()
      .onChange(of: store.conversationId) {
        path = []
        unfolded = []
      }
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

  /// "Today 14:05", like Messages, when a message comes an hour or more after the one before.
  private func pause(_ m: ThreadMessage, after previous: ThreadMessage?) -> String? {
    guard let date = Format.date(m.createdAt) else { return nil }
    if let prev = Format.date(previous?.createdAt), date.timeIntervalSince(prev) < 3600 { return nil }
    let time = date.formatted(date: .omitted, time: .shortened)
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Today \(time)" }
    if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
    if let weekAgo = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: .now)), date >= weekAgo {
      return "\(date.formatted(.dateTime.weekday(.wide))) \(time)"
    }
    let thisYear = calendar.isDate(date, equalTo: .now, toGranularity: .year)
    let day = thisYear
      ? date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
      : date.formatted(.dateTime.day().month(.abbreviated).year())
    return "\(day) at \(time)"
  }

  private var uploading: Bool { files.contains { $0.attachment == nil && $0.error == nil } }

  private var canSend: Bool {
    let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let hasFiles = files.contains { $0.attachment != nil }
    return (hasText || hasFiles) && !sending && !uploading
  }

  /// Adds a file to the composer and uploads it straight away.
  private func attach(_ data: Data, name: String, mediaType: String, preview: UIImage? = nil) {
    let f = ComposerFile(name: name, preview: preview)
    files.append(f)
    Task {
      do {
        let a = try await store.upload(data, name: name, mediaType: mediaType)
        if let i = files.firstIndex(where: { $0.id == f.id }) { files[i].attachment = a }
      } catch {
        if let i = files.firstIndex(where: { $0.id == f.id }) { files[i].error = message(for: error) }
        self.error = message(for: error)
      }
    }
  }

  private var composer: some View {
    VStack(spacing: 6) {
      // The oldest approval waiting for you; the next shows once you've answered it.
      if let a = store.pendingApprovals.first {
        VStack(alignment: .leading, spacing: 10) {
          ApprovalBody(approval: a).id(a.id)
          if store.pendingApprovals.count > 1 {
            Text("\(store.pendingApprovals.count - 1) more waiting")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .glassSurface(in: .rect(cornerRadius: 22))
      }
      if let error {
        Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
      }
      if !files.isEmpty {
        ComposerFiles(files: files) { id in files.removeAll { $0.id == id } }
      }
      if !commands.isEmpty { commandList }
      HStack(alignment: .bottom, spacing: 8) {
        Menu {
          Button("Photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
          Button("Files", systemImage: "folder") { pickingFiles = true }
        } label: {
          Image(systemName: "paperclip")
            .font(.body.weight(.semibold))
            .frame(width: 26, height: 30)
        }
        .glassButton()
        .buttonBorderShape(.circle)
        .accessibilityLabel("Attach")
        TextField(store.incognito ? "Message \(name) incognito…" : "Message \(name)…", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .padding(.horizontal, 16)
          .padding(.vertical, 11)
          .glassSurface(in: .rect(cornerRadius: 22), interactive: true)
        Button { send() } label: {
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
    .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 10, matching: .images)
    .onChange(of: photos) { _, picked in
      guard !picked.isEmpty else { return }
      photos = []
      Task {
        for (i, item) in picked.enumerated() {
          guard let data = try? await item.loadTransferable(type: Data.self),
            let photo = PickedFile.photo(data, index: files.count + i + 1)
          else {
            error = "Couldn't read that photo."
            continue
          }
          attach(photo.data, name: photo.name, mediaType: "image/jpeg", preview: photo.preview)
        }
      }
    }
    .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      guard case let .success(urls) = result else { return }
      for url in urls.prefix(10) {
        guard let f = PickedFile.file(url) else {
          error = "Couldn't read \(url.lastPathComponent)."
          continue
        }
        attach(f.data, name: f.name, mediaType: f.mediaType)
      }
    }
  }

  private var commands: [ChatCommand] { ChatCommand.matching(draft, incognito: store.incognito) }

  /// What "/…" could mean. One that needs more goes in the composer to finish; the rest run at once.
  private var commandList: some View {
    VStack(spacing: 0) {
      ForEach(commands) { c in
        Button {
          if c.needsMore { draft = "/\(c.name) " } else { send("/\(c.name)") }
        } label: {
          HStack(alignment: .firstTextBaseline) {
            let args = Text(c.args.isEmpty ? "" : " \(c.args)").foregroundStyle(.secondary)
            Text("\(Text("/\(c.name)").fontWeight(.medium))\(args)")
            Spacer(minLength: 12)
            Text(c.description).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.vertical, 4)
    .glassSurface(in: .rect(cornerRadius: 22))
  }

  /// Sends the composer, or `command` when you picked one from the list.
  private func send(_ command: String? = nil) {
    let typed = command ?? draft
    let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let attached = command == nil ? files : []
    let ids = attached.compactMap { $0.attachment?.id }
    guard command != nil ? !sending : canSend else { return }
    sending = true
    error = nil
    // Cleared before it's sent, and put back if sending fails.
    draft = ""
    if command == nil { files = [] }
    withAnimation { position.scrollTo(edge: .bottom) }
    Task {
      // The keyboard can commit an autocorrection into the field just after it's cleared.
      try? await Task.sleep(for: .milliseconds(80))
      if !draft.isEmpty && typed.hasSuffix(draft) { draft = "" }
    }
    Task {
      do {
        try await store.send(text, attachmentIds: ids)
      } catch {
        if draft.isEmpty { draft = typed }
        if files.isEmpty && !attached.isEmpty { files = attached }
        self.error = message(for: error)
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
  /// The last of a run from the same sender, so its bubble has a tail.
  let tail: Bool
  let open: (Route) -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var onScreen = false

  var body: some View {
    if m.isNote {
      // What came of a command: a quiet line rather than a message.
      Text(m.text)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    } else if m.role == .user {
      let shape = Bubble(tail: tail, side: .trailing)
      VStack(alignment: .trailing, spacing: 4) {
        if let list = m.attachments, !list.isEmpty { MessageFiles(list: list, alignment: .trailing) }
        if !m.text.isEmpty {
          Text(m.text)
            .foregroundStyle(.white)
            .textSelection(.enabled)
            .padding(Bubble.insets(.trailing))
            .background(Color.userBubble, in: shape)
            .contentShape(.contextMenuPreview, shape)
            .contextMenu { copyButton(m.text) }
        }
      }
      .padding(.leading, 56)
      .frame(maxWidth: .infinity, alignment: .trailing)
    } else {
      let shape = Bubble(tail: tail, side: .leading)
      let unread = store.unread.contains(m.id)
      VStack(alignment: .leading, spacing: 3) {
        VStack(alignment: .leading, spacing: 8) { content }
          .padding(Bubble.insets(.leading))
          .background(Color.botBubble, in: shape)
          .contentShape(.contextMenuPreview, shape)
          .contextMenu { menu }
        // Like Messages' "Edited": the task's result changed this message after it was sent.
        if m.status != .streaming, let editedAt {
          Text("Edited \(editedAt.timeText)")
            .font(.caption2)
            .foregroundStyle(Color.brand)
            .padding(.leading, Bubble.tailWidth + 12)
        }
      }
      .padding(.trailing, 40)
      .frame(maxWidth: .infinity, alignment: .leading)
      // Unread: an accent line at the edge, fading once you've seen it.
      .overlay(alignment: .leading) {
        Capsule().fill(Color.brand).frame(width: 3).padding(.vertical, 4).offset(x: -9)
          .opacity(unread ? 1 : 0)
          .animation(.easeOut(duration: 1), value: unread)
      }
      .onScrollVisibilityChange(threshold: 0.5) { onScreen = $0 }
      // On screen for a moment, with the app in front: seen.
      .task(id: unread && onScreen && scenePhase == .active) {
        guard unread && onScreen && scenePhase == .active else { return }
        try? await Task.sleep(for: .seconds(1.5))
        if !Task.isCancelled { store.markSeen([m.id]) }
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch m.kind {
    case .task where m.taskId != nil: TaskMessage(taskId: m.taskId!)
    case .schedule where m.scheduleId != nil: ScheduleMessage(scheduleId: m.scheduleId!)
    default: ReplyMessage(m: m)
    }
    if let list = m.attachments, !list.isEmpty { MessageFiles(list: list, alignment: .leading) }
  }

  /// When a task's result changed the message after it was sent. A brain from before doesn't say: then a
  /// reply's task once it ends, or a task card that showed it running (one added when it ended wasn't).
  private var editedAt: String? {
    if let editedAt = m.editedAt { return editedAt }
    guard let task = m.taskId.flatMap({ store.tasks[$0] }), let done = task.finishedAt else { return nil }
    switch m.kind {
    case .text, .command: return done
    case .task: return done > m.createdAt ? done : nil
    case .schedule: return nil
    }
  }

  /// What Copy copies, and what Open opens.
  @ViewBuilder
  private var menu: some View {
    switch m.kind {
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
        // A finished or failed task's result replaced the reply.
        copyButton(task.map(ReplyMessage.replaced) == true ? result ?? "" : m.text)
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

/// A reply, with the task it started (if any) working under it. A task that finished or failed replaces
/// the reply with its result; a cancelled one leaves the reply.
private struct ReplyMessage: View {
  let m: ThreadMessage
  @Environment(AppStore.self) private var store

  static func replaced(_ task: AgentTask) -> Bool {
    !task.isActive && task.status != .cancelled
  }

  var body: some View {
    let task = m.taskId.flatMap { store.tasks[$0] }
    let replaced = task.map(Self.replaced) ?? false
    if !m.text.isEmpty && !replaced { MarkdownText(text: m.text) }
    if m.status == .streaming && m.text.isEmpty && m.taskId == nil { TypingDots() }
    if m.status == .streaming, let note = Format.lastLine(store.progress[m.id]) {
      Text(note).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
    }
    if m.status == .streaming, let used = store.usage[m.id] {
      Text("\(Format.tokens(used.tokens)) tokens · \(String(format: "$%.3f", used.costUsd))")
        .font(.footnote.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    if !m.text.isEmpty && !replaced, let task, !task.isActive { Divider() }
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
        if let result = result(task) { MarkdownText(text: result) }
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
    case .done: return "**\(task.title)**"
    case .failed: return "**\(task.title)** didn't finish."
    default: return "**\(task.title)** was cancelled."
    }
  }

  /// How it ended, under its title.
  private func result(_ task: AgentTask) -> String? {
    if task.isActive { return nil }
    switch task.status {
    case .done: return task.summary ?? "Done."
    case .failed: return task.summary
    default: return nil
    }
  }

  private func note(_ task: AgentTask) -> String {
    store.desktop?.control == .owner && task.status == .running
      ? "Paused while you have control."
      : Format.taskLine(task, progress: store.taskProgress[taskId])
  }
}

/// What Hatbot wants to do and why, the page it read, a screenshot, then Deny and Approve.
struct ApprovalBody: View {
  let approval: Approval
  @Environment(AppStore.self) private var store
  @State private var busy = false
  @State private var error: String?
  @State private var note = ""

  var body: some View {
    let a = approval
    // The summary can be a whole shell command: shown as written, not read as Markdown.
    Text("\(Text("Can I go ahead?").bold()) \(a.summary)").textSelection(.enabled)
    let text = [
      a.reason,
      a.sources.isEmpty ? "" : "_After reading \(a.sources.joined(separator: ", "))_",
    ].filter { !$0.isEmpty }.joined(separator: "\n\n")
    if !text.isEmpty { MarkdownText(text: text) }
    if let taskId = a.taskId, let stepId = a.screenshotStepId {
      Screenshot(taskId: taskId, stepId: stepId)
    }
    if a.takesNote {
      TextField("Tell it what to do instead, or how to go ahead", text: $note, axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.roundedBorder)
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
        try await store.decide(approval.id, decision, note: note)
      } catch {
        self.error = message(for: error)
        busy = false
      }
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

/// A Messages bubble: a rounded rectangle, with a tail curling out of the bottom corner on `side`.
/// The tail's room is kept even without one, so a run of bubbles lines up.
private struct Bubble: Shape {
  var tail: Bool
  var side: HorizontalEdge
  static let tailWidth: CGFloat = 6

  /// The text's padding inside the bubble, with room for the tail.
  static func insets(_ side: HorizontalEdge) -> EdgeInsets {
    EdgeInsets(
      top: 7, leading: 12 + (side == .leading ? tailWidth : 0),
      bottom: 7, trailing: 12 + (side == .trailing ? tailWidth : 0))
  }

  func path(in rect: CGRect) -> Path {
    // Drawn with the tail on the right, then flipped for the left.
    let w = rect.width
    let h = rect.height
    let body = w - Self.tailWidth
    let r = min(18, h / 2, body / 2)
    var p = Path()
    p.move(to: CGPoint(x: r, y: 0))
    p.addArc(tangent1End: CGPoint(x: body, y: 0), tangent2End: CGPoint(x: body, y: h), radius: r)
    if tail && h >= r + 10 {
      p.addLine(to: CGPoint(x: body, y: h - 10))
      p.addCurve(to: CGPoint(x: w, y: h), control1: CGPoint(x: body, y: h - 3), control2: CGPoint(x: w - 2, y: h))
      p.addCurve(
        to: CGPoint(x: body - 9, y: h - 1.5),
        control1: CGPoint(x: w - 4, y: h - 0.5), control2: CGPoint(x: body - 3, y: h - 1.5))
      p.addQuadCurve(to: CGPoint(x: body - 13, y: h), control: CGPoint(x: body - 11, y: h))
    } else {
      p.addArc(tangent1End: CGPoint(x: body, y: h), tangent2End: CGPoint(x: 0, y: h), radius: r)
    }
    p.addArc(tangent1End: CGPoint(x: 0, y: h), tangent2End: CGPoint(x: 0, y: 0), radius: r)
    p.addArc(tangent1End: CGPoint(x: 0, y: 0), tangent2End: CGPoint(x: body, y: 0), radius: r)
    p.closeSubpath()
    let flip = side == .leading ? CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -w, y: 0) : .identity
    return p.applying(flip.concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
  }
}
