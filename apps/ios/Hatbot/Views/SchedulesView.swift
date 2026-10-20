// Schedules & Triggers (PLAN.md §5.6, §8): what runs on its own. Schedules can be made here; webhooks and
// Uptime Kuma triggers are set up on the web, where their URL gets pasted into the sender.
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct SchedulesView: View {
  @Environment(AppStore.self) private var store
  @State private var loaded = false
  @State private var error: String?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red) }
      Section("Schedules") {
        let schedules = store.schedules.values.sorted { $0.id < $1.id }
        if loaded && schedules.isEmpty {
          Text("No schedules. Ask Hatbot in the chat, or add one.").foregroundStyle(.secondary)
        }
        ForEach(schedules) { s in
          NavigationLink(value: Route.schedule(s.id)) {
            Row(
              name: s.name, enabled: s.enabled,
              detail: Format.when(cron: s.cron, runAt: s.runAt))
          }
        }
      }
      Section("Triggers") {
        let triggers = store.triggers.values.sorted { $0.id < $1.id }
        if loaded && triggers.isEmpty {
          Text("No triggers. Set up webhooks and Uptime Kuma on the web.").foregroundStyle(.secondary)
        }
        ForEach(triggers) { t in
          NavigationLink(value: Route.trigger(t.id)) {
            Row(name: t.name, enabled: t.enabled, detail: t.kind == .kuma ? "Uptime Kuma" : "Webhook")
          }
        }
      }
    }
    .navigationTitle("Schedules & Triggers")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem {
        NavigationLink(value: Route.newSchedule) { Label("New schedule", systemImage: "plus") }
      }
    }
    .refreshable { await load() }
    .task { await load() }
  }

  private func load() async {
    await attempt($error) { try await store.loadSchedules() }
    loaded = true
  }

  private struct Row: View {
    let name: String
    let enabled: Bool
    let detail: String

    var body: some View {
      VStack(alignment: .leading, spacing: 3) {
        Text(name).foregroundStyle(enabled ? .primary : .secondary)
        Text(enabled ? detail : "Off").font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
}

/// A schedule to edit, or a new one (`id` nil).
struct ScheduleDetailView: View {
  let id: Int?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var form: Form?
  @State private var missing = false
  @State private var busy = false
  @State private var confirmDelete = false
  @State private var error: String?
  @State private var started: Int?

  typealias Form = ScheduleForm

  private var stored: Schedule? { id.flatMap { store.schedules[$0] } }

  var body: some View {
    Group {
      if missing {
        ContentUnavailableView("This schedule doesn't exist.", systemImage: "questionmark.circle")
      } else if let form = Binding($form) {
        editor(form)
      } else {
        ProgressView()
      }
    }
    .navigationTitle(id == nil ? "New schedule" : stored?.name ?? "Schedule")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: id) {
      guard let id else {
        form = Form()
        return
      }
      await attempt($error, missing: $missing) {
        try await store.loadSchedule(id)
        if let s = store.schedules[id] { form = Form(s) }
      }
    }
  }

  private func editor(_ form: Binding<Form>) -> some View {
    let f = form.wrappedValue
    let changed = stored.map { Form($0) != f } ?? true
    return SwiftUI.Form {
      if let error { Text(error).foregroundStyle(.red) }
      if let stored, stored.tainted == true {
        let read = stored.taintedBy.map { " (\($0))" } ?? ""
        Label(
          "Made or changed by the chat after it read untrusted content\(read), so its runs ask before changing anything. Saving it yourself clears this.",
          systemImage: "exclamationmark.shield"
        )
        .font(.footnote)
        .foregroundStyle(.orange)
      }
      Section {
        TextField("Name", text: form.name)
        Toggle("On", isOn: form.enabled)
        if store.botIds.count > 1 {
          Picker("Runs as", selection: form.botId) {
            ForEach(store.botIds, id: \.self) { Text(store.botName($0)).tag($0) }
          }
        }
      }
      Section {
        Picker("When", selection: form.repeats) {
          Text("Repeats").tag(true)
          Text("Once").tag(false)
        }
        .pickerStyle(.segmented)
        if f.repeats {
          TextField("Cron", text: form.cron)
            .font(.body.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Text(Format.describeCron(f.cron)).foregroundStyle(.secondary)
        } else {
          DatePicker("At", selection: form.at, in: Date()...)
        }
      } footer: {
        if f.repeats { Text("Minute, hour, day of month, month, day of week, in the brain's time zone.") }
      }
      Section("What it does") {
        TextField("Everything the run needs to know: it can't see the chat.", text: form.prompt, axis: .vertical)
          .lineLimit(4...16)
      }
      if let s = stored {
        Section {
          if let last = s.lastTaskId {
            NavigationLink("Last run", value: Route.task(last))
          }
          if let next = s.nextRunAt, s.enabled {
            LabeledContent("Next run", value: next.stampText)
          }
          Button("Run now") { Task { await run(s.id) } }.disabled(busy)
          if let started {
            NavigationLink("Started task #\(started)", value: Route.task(started))
          }
        }
        Section {
          Button("Delete schedule", role: .destructive) { confirmDelete = true }
        }
      }
    }
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button(id == nil ? "Add" : "Save") { Task { await save(f) } }
          .disabled(busy || !f.valid || !changed)
      }
    }
    .confirmingDelete("Delete “\(f.name)”?", isPresented: $confirmDelete, error: $error) {
      if let id { try await store.deleteSchedule(id) }
    }
  }

  private func save(_ f: Form) async {
    busy = true
    defer { busy = false }
    await attempt($error) {
      if let id {
        form = Form(try await store.saveSchedule(id, f.change))
        store.toast = "Saved"
      } else {
        _ = try await store.createSchedule(f.change)
        store.toast = "Scheduled \(f.name)"
        dismiss()
      }
    }
  }

  private func run(_ id: Int) async {
    busy = true
    defer { busy = false }
    await attempt($error) { started = try await store.runSchedule(id).id }
  }
}

/// A trigger: its switch, trust and instructions; a new secret; delete.
struct TriggerDetailView: View {
  let id: Int
  @Environment(AppStore.self) private var store
  @State private var name = ""
  @State private var prompt = ""
  @State private var loaded = false
  @State private var missing = false
  @State private var secret: TriggerWithSecret?
  @State private var confirmSecret = false
  @State private var confirmDelete = false
  @State private var error: String?
  /// What a switch or picker was set to, until the brain has saved it.
  @State private var setting = AppStore.TriggerChange()

  var body: some View {
    Group {
      if missing {
        ContentUnavailableView("This trigger doesn't exist.", systemImage: "questionmark.circle")
      } else if let t = store.triggers[id], loaded {
        form(t)
      } else {
        ProgressView()
      }
    }
    .navigationTitle(store.triggers[id]?.name ?? "Trigger")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: id) {
      await attempt($error, missing: $missing) {
        try await store.loadTrigger(id)
        if let t = store.triggers[id] {
          name = t.name
          prompt = t.prompt
        }
        loaded = true
      }
    }
  }

  private func form(_ t: Trigger) -> some View {
    let changed = name != t.name || prompt != t.prompt
    return Form {
      if let error { Text(error).foregroundStyle(.red) }
      if let secret {
        Section {
          Text(
            t.kind == .kuma
              ? "Paste this Post URL into Uptime Kuma's Webhook notification. It holds the secret and isn't shown again."
              : "Use this as the webhook's secret. It isn't shown again."
          )
          .font(.footnote)
          let value = t.kind == .kuma ? secret.postURL : secret.secret
          // Not selectable: the system's Copy would put it on every device's pasteboard, for good.
          Text(value).font(.footnote.monospaced())
          // Kept off your other devices' pasteboards, and only for two minutes.
          Button("Copy", systemImage: "doc.on.doc") {
            UIPasteboard.general.setItems(
              [[UTType.plainText.identifier: value]],
              options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
          }
        } header: {
          Text("New secret")
        }
      }
      Section {
        TextField("Name", text: $name)
        Toggle("On", isOn: saving(t.enabled, \.enabled))
        if store.botIds.count > 1 {
          Picker("Runs as", selection: saving(t.botId ?? Bot.hatbot, \.botId)) {
            ForEach(store.botIds, id: \.self) { Text(store.botName($0)).tag($0) }
          }
        }
        if t.kind == .webhook {
          Toggle("Trust its payloads", isOn: saving(t.trusted, \.trusted))
        }
        if t.kind == .kuma, let checks = t.confirmChecks {
          Picker("Start a task after", selection: saving(checks, \.confirmChecks)) {
            Text("First failure").tag(0)
            Text("2 failures").tag(1)
            Text("3 failures").tag(2)
          }
        }
      } footer: {
        if t.kind == .webhook {
          Text("Untrusted payloads make the run ask before it changes anything.")
        }
      }
      Section("What it does") {
        TextField("Instructions", text: $prompt, axis: .vertical).lineLimit(4...16)
      }
      Section {
        LabeledContent(t.kind == .kuma ? "Uptime Kuma" : "Webhook") {
          Text(t.url).font(.footnote.monospaced()).textSelection(.enabled)
        }
        if let last = t.lastTaskId {
          NavigationLink("Last run", value: Route.task(last))
        }
        Button("New secret") { confirmSecret = true }
      }
      Section {
        Button("Delete trigger", role: .destructive) { confirmDelete = true }
      }
    }
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") {
          Task {
            await attempt($error) {
              _ = try await store.saveTrigger(id, AppStore.TriggerChange(name: name, prompt: prompt))
              store.toast = "Saved"
            }
          }
        }
        .disabled(!changed || name.trimmingCharacters(in: .whitespaces).isEmpty
          || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .confirmationDialog(
      "Replace the secret? The old one stops working right away.", isPresented: $confirmSecret,
      titleVisibility: .visible
    ) {
      Button("New secret", role: .destructive) {
        Task { await attempt($error) { secret = try await store.newTriggerSecret(id) } }
      }
    }
    .confirmingDelete("Delete “\(t.name)”?", isPresented: $confirmDelete, error: $error) {
      try await store.deleteTrigger(id)
    }
  }

  /// A switch or picker that saves as soon as it's changed; then the trigger shows what was saved.
  private func saving<V: Equatable & Sendable>(_ value: V, _ key: WritableKeyPath<AppStore.TriggerChange, V?>) -> Binding<V> {
    .saving(value, shown: $setting[dynamicMember: key]) { new in
      var change = AppStore.TriggerChange()
      change[keyPath: key] = new
      await attempt($error) { _ = try await store.saveTrigger(id, change) }
    }
  }
}
