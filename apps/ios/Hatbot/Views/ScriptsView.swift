// Scripts are written in the chat, and changed and approved on the web, where saving one as it is
// approves it.
import SwiftUI

struct ScriptDetailView: View {
  let id: Int
  @Environment(AppStore.self) private var store
  @State private var notFound = false
  @State private var input: [String: String] = [:]
  /// On or off as switched, until the brain has saved it.
  @State private var enabled: Bool?
  @State private var busy = false
  @State private var started: Int?
  @State private var confirmDelete = false
  @State private var error: String?

  private var script: Script? { store.scripts[id] }
  private var missing: Bool { notFound || store.deletedScripts.contains(id) }
  /// A run of it that hasn't ended: the brain starts no other until it does.
  private var running: Bool {
    store.tasks.values.contains { $0.scriptId == id && $0.parentId == nil && $0.isActive }
  }

  var body: some View {
    Group {
      if let s = script {
        content(s)
      } else if missing {
        ContentUnavailableView("This script doesn't exist.", systemImage: "questionmark.circle")
      } else {
        ProgressView()
      }
    }
    .navigationTitle(script?.name ?? "Script")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: id) { await load() }
  }

  private func content(_ s: Script) -> some View {
    TiledForm {
      if let error { Text(error).foregroundStyle(Color.danger) }
      if s.unapproved {
        note(
          "It changes things with \(s.writes.joined(separator: ", ")), and you haven't approved it as it is, so it doesn't run. Check what it does, then save it on the web."
        )
      }
      if s.tainted {
        let read = s.taintedBy.map { " (\($0))" } ?? ""
        note(
          "\(store.botName(s.botId)) wrote this after reading untrusted content\(read), so its runs start tainted. Check what it does, then save it on the web."
        )
      }
      Section {
        Toggle(
          "On",
          isOn: .saving(s.enabled, shown: $enabled) { on in
            await attempt($error) { try await store.setScriptEnabled(id, on) }
          })
        Text(s.description)
        if store.botIds.count > 1 {
          LabeledContent("Bot", value: store.botName(s.botId))
        }
      }
      Section("What it does") {
        Text(ScriptSteps.lines(s.steps).joined(separator: "\n"))
          .font(.code(.footnote))
          .textSelection(.enabled)
      }
      if !s.inputs.isEmpty {
        Section("Inputs") {
          ForEach(s.inputs, id: \.name) { i in
            LabeledContent(i.name) {
              TextField(i.description, text: $input[i.name, default: ""])
                .multilineTextAlignment(.trailing)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
          }
        }
      }
      Section {
        Button(running ? "Running" : busy ? "Starting…" : "Run now") { Task { await run(s) } }
          .disabled(busy || running || !s.enabled || s.unapproved)
        if let started {
          NavigationLink("Started task #\(started)", value: Route.task(started))
        } else if let last = s.lastTaskId {
          NavigationLink("Last run", value: Route.task(last))
        }
      }
      Section {
        Button("Delete script", role: .destructive) { confirmDelete = true }
      }
    }
    .refreshable { await load() }
    .confirmingDelete(
      "Delete “\(s.name)”? Its past runs stay in Tasks.", isPresented: $confirmDelete, error: $error
    ) {
      try await store.deleteScript(id)
    }
  }

  private func note(_ text: String) -> some View {
    Label(text, systemImage: "exclamationmark.shield")
      .font(.sans(.footnote))
      .foregroundStyle(Color.attention)
  }

  private func run(_ s: Script) async {
    busy = true
    defer { busy = false }
    let given = Dictionary(
      s.inputs.map { ($0.name, ScriptSteps.typed(input[$0.name] ?? "")) }, uniquingKeysWith: { a, _ in a })
    await attempt($error) { started = try await store.runScript(id, input: given).id }
  }

  private func load() async {
    await attempt($error, missing: $notFound) { try await store.loadScript(id) }
  }
}
