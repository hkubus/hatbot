// Search, and what looks after things on its own: watchers, Check everything, the heartbeat, and
// memory changes Hatbot proposes.
import SwiftUI

/// Chats, tasks, memory and what runs on its own, from one box. A message opens its chat.
struct SearchView: View {
  /// Opens a chat by conversation id, at a message.
  let openMessage: (_ conversationId: Int, _ messageId: Int) -> Void
  @Environment(AppStore.self) private var store
  @State private var query = ""
  @State private var results: SearchResults?
  @State private var error: String?

  var body: some View {
    NavigationStack {
      List {
        if let error { Text(error).foregroundStyle(.red) }
        if let r = results {
          if r.isEmpty {
            Text("Nothing found.").foregroundStyle(.secondary)
          }
          if !r.messages.isEmpty {
            Section("Messages") {
              ForEach(r.messages) { m in
                Button {
                  openMessage(m.conversationId, m.id)
                } label: {
                  VStack(alignment: .leading, spacing: 3) {
                    Text("\(m.botId.map { store.botName($0) } ?? "You"), \(m.createdAt.stampText)")
                      .font(.footnote).foregroundStyle(.secondary)
                    Snippet(text: m.snippet)
                  }
                }
                .buttonStyle(.plain)
              }
            }
          }
          if !r.tasks.isEmpty {
            Section("Tasks") {
              ForEach(r.tasks) { t in
                NavigationLink(value: Route.task(t.id)) { Text(t.title) }
              }
            }
          }
          if !r.memory.isEmpty {
            Section("Memory") {
              ForEach(r.memory) { m in
                NavigationLink(value: Route.memoryFile(m.path)) {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(m.path).font(.footnote).foregroundStyle(.secondary)
                    Text(m.text).lineLimit(3)
                  }
                }
              }
            }
          }
          if !r.routines.isEmpty {
            Section("Schedules, triggers and watchers") {
              ForEach(r.routines, id: \.route) { x in
                NavigationLink(x.name, value: x.route)
              }
            }
          }
        }
      }
      .navigationTitle("Search")
      .sidebarButton()
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
      .autocorrectionDisabled()
      .task(id: query) {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else {
          results = nil
          return
        }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        do {
          results = try await store.search(q)
          error = nil
        } catch is CancellationError {
        } catch {
          self.error = message(for: error)
        }
      }
      .routes()
    }
  }
}

extension SearchResults.RoutineHit {
  var route: Route {
    switch kind {
    case .schedule: .schedule(id)
    case .trigger: .trigger(id)
    case .watcher: .watcher(id)
    }
  }
}

/// A snippet with the matched words in bold.
private struct Snippet: View {
  let text: String

  var body: some View {
    Search.parts(text).reduce(Text("")) { out, part in
      out + (part.match ? Text(part.text).bold().foregroundColor(.accentColor) : Text(part.text))
    }
    .lineLimit(3)
  }
}

// MARK: Watchers

struct WatchersView: View {
  @Environment(AppStore.self) private var store
  @State private var error: String?

  /// As loaded, then kept up to date by the event stream.
  private var watchers: [Watcher]? {
    store.watchersLoaded ? store.watchers.values.sorted { $0.id < $1.id } : nil
  }

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red) }
      if let watchers, watchers.isEmpty {
        Text("No watchers. Ask Hatbot in the chat to watch a page or a value.").foregroundStyle(.secondary)
      }
      ForEach(watchers ?? []) { w in
        NavigationLink(value: Route.watcher(w.id)) {
          VStack(alignment: .leading, spacing: 3) {
            Text(w.name).foregroundStyle(w.enabled ? .primary : .secondary)
            Text(line(w)).font(.footnote).foregroundStyle(w.lastError == nil ? Color.secondary : .red)
          }
        }
      }
    }
    .overlay { if watchers == nil && error == nil { ProgressView() } }
    .navigationTitle("Watchers")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await load() }
    .task { await load() }
  }

  private func line(_ w: Watcher) -> String {
    if !w.enabled { return "Off" }
    if let e = w.lastError { return e }
    return "\(w.condition.description), \(Watcher.every(w.everyMinutes).lowercased())"
  }

  private func load() async {
    do {
      try await store.loadWatchers()
      error = nil
    } catch {
      self.error = message(for: error)
    }
  }
}

/// A watcher: what it looks at, what it saw, its switch, Look now and Delete. It's made and changed
/// in the chat or on the web.
struct WatcherDetailView: View {
  let id: Int
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var values: [WatcherValue] = []
  @State private var notFound = false

  /// Kept up to date by the event stream.
  private var watcher: Watcher? { store.watchers[id] }
  private var missing: Bool { notFound || store.deletedWatchers.contains(id) }
  @State private var busy = false
  /// On or off as switched, until the brain has saved it.
  @State private var enabled: Bool?
  /// Running the page's scripts, as switched, until the brain has read the page that way.
  @State private var render: Bool?
  @State private var confirmDelete = false
  @State private var error: String?

  var body: some View {
    Group {
      if let w = watcher {
        content(w)
      } else if missing {
        ContentUnavailableView("This watcher doesn't exist.", systemImage: "questionmark.circle")
      } else {
        ProgressView()
      }
    }
    .navigationTitle(watcher?.name ?? "Watcher")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: id) { await load() }
    // It looked again: what it saw has another value.
    .onChange(of: watcher?.lastCheckedAt) { _, checked in
      if checked != nil { Task { values = (try? await store.watcherValues(id)) ?? values } }
    }
  }

  private func content(_ w: Watcher) -> some View {
    Form {
      if let error { Text(error).foregroundStyle(.red) }
      Section {
        Toggle(
          "On",
          isOn: .saving(w.enabled, shown: $enabled) { on in
            await act { _ = try await store.setWatcherEnabled(id, on) }
          })
        LabeledContent(w.source.kind == .page ? "Page" : "Tool", value: w.source.text)
        if w.source.kind == .page {
          Toggle(
            "Run the page's scripts",
            isOn: .saving(w.source.render == true, shown: $render) { on in
              await act { _ = try await store.setWatcherRender(id, on) }
            })
          .disabled(render != nil)
        }
        if let s = w.source.selector { LabeledContent("Selector", value: s) }
        if let p = w.source.path { LabeledContent("Path", value: p) }
        if let p = w.source.pattern { LabeledContent("Pattern", value: p) }
        LabeledContent("Counts when", value: w.condition.description)
        LabeledContent("How often", value: Watcher.every(w.everyMinutes))
        if w.once { LabeledContent("Then", value: "Switches off") }
        LabeledContent("Bot", value: store.botName(w.botId))
      }
      if !w.prompt.isEmpty {
        Section("When it counts") { Text(w.prompt) }
      }
      Section("Last look") {
        if let e = w.lastError {
          Text(e).foregroundStyle(.red)
        }
        if let v = w.lastValue {
          Text(v).font(.system(.callout, design: .monospaced)).lineLimit(8).textSelection(.enabled)
        }
        if let at = w.lastCheckedAt { LabeledContent("Looked", value: at.stampText) }
        if let taskId = w.lastTaskId { NavigationLink("Its last task", value: Route.task(taskId)) }
        Button(busy ? "Looking…" : "Look now") {
          Task {
            busy = true
            await act {
              _ = try await store.checkWatcher(id)
              values = try await store.watcherValues(id)
            }
            busy = false
          }
        }
        .disabled(busy)
      }
      if !values.isEmpty {
        Section("Values") {
          ForEach(values) { v in
            VStack(alignment: .leading, spacing: 3) {
              Text(v.value).font(.system(.callout, design: .monospaced)).lineLimit(3)
              Text(v.fired ? "\(v.createdAt.stampText), counted" : v.createdAt.stampText)
                .font(.footnote).foregroundStyle(v.fired ? Color.accentColor : .secondary)
            }
          }
        }
      }
      Section {
        Button("Delete watcher", role: .destructive) { confirmDelete = true }
      }
    }
    .refreshable { await load() }
    .confirmationDialog("Delete “\(w.name)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task {
          await act {
            try await store.deleteWatcher(id)
            dismiss()
          }
        }
      }
    }
  }

  private func load() async {
    do {
      async let w = store.loadWatcher(id)
      async let v = store.watcherValues(id)
      _ = try await w
      values = try await v
    } catch let e as APIError where e.status == 404 {
      notFound = true
    } catch {
      self.error = message(for: error)
    }
  }

  private func act(_ work: () async throws -> Void) async {
    error = nil
    do { try await work() } catch { self.error = message(for: error) }
  }
}

// MARK: Check everything

/// A quick, real try of each part Hatbot depends on.
struct ChecksView: View {
  @Environment(AppStore.self) private var store
  @State private var report: CheckReport?
  @State private var running = false
  @State private var error: String?
  /// The last test approval, kept up to date by the event stream.
  @State private var approvalId: Int?
  @State private var sending = false

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red) }
      Section("From your phone") {
        HStack {
          VStack(alignment: .leading, spacing: 3) {
            Text("Test approval")
            if let a = approvalId.flatMap({ store.approvals[$0] }) {
              Text(answer(a)).font(.footnote).foregroundStyle(.secondary)
            }
          }
          Spacer()
          Button("Send") { Task { await sendApproval() } }.disabled(sending)
        }
      }
      if let report {
        Section {
          ForEach(report.results) { r in
            HStack(alignment: .firstTextBaseline, spacing: 12) {
              Image(systemName: r.state.symbol).foregroundStyle(r.state.tint)
              VStack(alignment: .leading, spacing: 3) {
                Text(r.name)
                if !r.detail.isEmpty {
                  Text(r.detail).font(.footnote).foregroundStyle(.secondary)
                }
              }
            }
            .accessibilityElement(children: .combine)
          }
        } header: {
          Text(report.finishedAt.stampText)
        }
      } else if !running {
        Text("Not run yet.").foregroundStyle(.secondary)
      }
    }
    .overlay { if running && report == nil { ProgressView() } }
    .navigationTitle("Check everything")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem {
        Button(running ? "Checking…" : "Check") { Task { await run() } }.disabled(running)
      }
    }
    .task {
      do {
        let info = try await store.loadChecks()
        report = info.report
        approvalId = info.approval?.id
      } catch { self.error = message(for: error) }
    }
  }

  private func answer(_ a: Approval) -> String {
    var text =
      switch a.status {
      case .pending: "Waiting for your answer"
      case .approved: "Approved"
      case .denied: "Denied"
      case .expired: "Expired"
      case .cancelled: "Replaced"
      }
    if a.decidedVia == "ntfy" { text += " from the notification" }
    if let at = a.decidedAt { text += ", \(at.stampText)" }
    return text
  }

  private func sendApproval() async {
    sending = true
    error = nil
    do { approvalId = try await store.sendTestApproval().id } catch { self.error = message(for: error) }
    sending = false
  }

  private func run() async {
    running = true
    error = nil
    do { report = try await store.runChecks() } catch { self.error = message(for: error) }
    running = false
  }
}

extension CheckResult.State {
  var symbol: String {
    switch self {
    case .ok: "checkmark.circle.fill"
    case .warn: "exclamationmark.triangle.fill"
    case .fail: "xmark.octagon.fill"
    case .skip: "minus.circle"
    }
  }

  var tint: Color {
    switch self {
    case .ok: .green
    case .warn: .orange
    case .fail: .red
    case .skip: .secondary
    }
  }
}

// MARK: Heartbeat

/// Every few minutes a look over what went wrong, without the model; only something new goes to Haiku,
/// which tells you, starts a task, or lets it be.
struct HeartbeatView: View {
  @Environment(AppStore.self) private var store
  @State private var settings: AppSettings.Heartbeat?
  @State private var info: HeartbeatInfo?
  @State private var looking = false
  @FocusState private var writing: Bool
  @State private var error: String?

  var body: some View {
    Form {
      if let error { Text(error).foregroundStyle(.red) }
      if let s = Binding($settings) {
        Section {
          Toggle("On", isOn: s.enabled).onChange(of: s.wrappedValue.enabled) { save() }
          Picker("Every", selection: s.everyMinutes) {
            ForEach(AppSettings.Heartbeat.everyChoices(with: s.wrappedValue.everyMinutes), id: \.self) { m in
              Text(AppSettings.Heartbeat.every(m)).tag(m)
            }
          }
          .onChange(of: s.wrappedValue.everyMinutes) { save() }
          Picker("Bot", selection: s.botId) {
            // With the one set now when it isn't among them: deleted, or not loaded yet.
            ForEach(store.botIds.including(s.wrappedValue.botId), id: \.self) { id in Text(store.botName(id)).tag(id) }
          }
          .onChange(of: s.wrappedValue.botId) { save() }
        }
        Section("What you want done") {
          TextField("Restart a monitor that's down once before telling me", text: s.instructions, axis: .vertical)
            .lineLimit(3...10)
            .focused($writing)
            .onSubmit { save() }
          Button("Save") { save() }
        }
      }
      Section("Last look") {
        if let info, let at = info.at {
          LabeledContent("Looked", value: at.stampText)
          ForEach(info.found, id: \.self) { Text($0) }
          if !info.note.isEmpty { Text(info.note).foregroundStyle(.secondary) }
          if let taskId = info.taskId { NavigationLink("Its task", value: Route.task(taskId)) }
        } else {
          Text("Not yet.").foregroundStyle(.secondary)
        }
        Button(looking ? "Looking…" : "Look now") {
          Task {
            looking = true
            defer { looking = false }
            do { info = try await store.runHeartbeat() } catch { self.error = message(for: error) }
          }
        }
        .disabled(looking)
      }
      if let recent = info?.recent, !recent.isEmpty {
        Section("Before") {
          ForEach(recent, id: \.at) { run in
            LabeledContent(run.at.stampText) {
              Text(Self.line(run)).multilineTextAlignment(.trailing)
            }
          }
        }
      }
    }
    .navigationTitle("Heartbeat")
    .navigationBarTitleDisplayMode(.inline)
    .onChange(of: store.heartbeatVersion) {
      Task { if let last = try? await store.loadHeartbeat() { info = last } }
    }
    // Changed elsewhere; not while you're writing what you want done.
    .onChange(of: store.settingsVersion) {
      guard !writing else { return }
      Task { if let all = try? await store.loadSettings() { settings = all.heartbeat } }
    }
    .task {
      do {
        async let s = store.loadSettings()
        async let i = store.loadHeartbeat()
        let (all, last) = try await (s, i)
        settings = all.heartbeat
        info = last
        if store.botIds.isEmpty { await store.loadBots() }
      } catch {
        self.error = message(for: error)
      }
    }
  }

  /// What a look found and did.
  static func line(_ run: HeartbeatInfo.Run) -> String {
    let found = run.found.isEmpty ? "Nothing" : run.found.joined(separator: ", ")
    switch run.action {
    case .notify: return "\(found), told you"
    case .task: return "\(found), started a task"
    case .nothing, nil: return found
    }
  }

  private func save() {
    guard let s = settings else { return }
    Task {
      do {
        error = nil
        settings = try await store.saveSettings(.init(heartbeat: s)).heartbeat
      } catch {
        self.error = message(for: error)
      }
    }
  }
}

// MARK: Proposals

/// A proposed change to memory as a diff per file: Apply commits it in your name, Dismiss drops it.
struct ProposalView: View {
  let proposal: Proposal
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var busy = false
  @State private var error: String?
  /// Each change's diff, worked out once and off the main thread, not on every redraw.
  @State private var diffs: [String: [DiffLine]]?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text(proposal.title).font(.headline)
        Text(proposal.reason)
        if let error { Text(error).foregroundStyle(.red) }
        ForEach(proposal.changes, id: \.path) { c in
          VStack(alignment: .leading, spacing: 6) {
            Text(c.before == nil ? "\(c.path) (new)" : c.after == nil ? "\(c.path) (deleted)" : c.path)
              .font(.subheadline.weight(.semibold))
            if let lines = diffs?[c.path] { DiffLines(lines: lines) } else { ProgressView() }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding()
    }
    .task(id: proposal.id) {
      let changes = proposal.changes
      diffs = await Task.detached(priority: .userInitiated) {
        Dictionary(changes.map { ($0.path, LineDiff.of($0.before, $0.after)) }, uniquingKeysWith: { a, _ in a })
      }.value
    }
    .navigationTitle(proposal.kind == .skill ? "Skill fix" : proposal.kind == .write ? "Memory change" : "Tidy-up")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if proposal.status == .pending {
        ToolbarItem(placement: .bottomBar) {
          Button("Dismiss", role: .destructive) {
            Task { await act { _ = try await store.dismissProposal(proposal.id) } }
          }
          .disabled(busy)
        }
        ToolbarItem(placement: .bottomBar) {
          Button("Apply") {
            Task {
              await act {
                _ = try await store.applyProposal(proposal.id)
                store.toast = "Applied"
              }
            }
          }
          .bold()
          .disabled(busy)
        }
      }
    }
  }

  /// Does it, then goes back to the list.
  private func act(_ work: () async throws -> Void) async {
    busy = true
    error = nil
    do {
      try await work()
      dismiss()
    } catch {
      self.error = message(for: error)
    }
    busy = false
  }
}

/// Diff lines, green for added and red for removed, scrolling sideways.
struct DiffLines: View {
  let lines: [DiffLine]

  var body: some View {
    ScrollView(.horizontal) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(lines.indices, id: \.self) { i in
          let line = lines[i]
          Text(line.text.isEmpty ? " " : line.text)
            .foregroundStyle(line.kind == .hunk ? .secondary : .primary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              line.kind == .added
                ? Color.green.opacity(0.15) : line.kind == .removed ? Color.red.opacity(0.15) : Color.clear)
        }
      }
      .font(.system(.caption, design: .monospaced))
      .textSelection(.enabled)
    }
  }
}
