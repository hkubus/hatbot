// A bot's page (PLAN.md §14): its name, role, model and plugins. No id makes one, from a template or not.
import SwiftUI

struct BotView: View {
  let id: String?
  /// After making one.
  var made: ((Bot) -> Void)?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var form = Form()
  @State private var plugins: [PluginName] = []
  @State private var templates: [BotTemplate] = []
  @State private var template: String?
  /// What the form was last filled with, blank or from a template, to tell whether you've changed it.
  @State private var filled = Form()
  /// A template picked over changes of yours, until you say whether it replaces them.
  @State private var replacing: Pick?
  @State private var busy = false
  @State private var confirmDelete = false
  @State private var error: String?

  struct Form: Equatable {
    var name = ""
    var icon = Bot.Icon.sparkles
    var color = Bot.Tint.amber
    var instructions = ""
    var chatModel: AppSettings.ChatModel?
    var chatEffort: AppSettings.Effort?
    var plugins: [String]?

    init() {}
    init(_ b: Bot) {
      name = b.name
      icon = b.icon
      color = b.color
      instructions = b.instructions
      chatModel = b.chatModel
      chatEffort = b.chatEffort
      plugins = b.plugins
    }
    init(_ t: BotTemplate) {
      name = t.name
      icon = t.icon
      color = t.color
      instructions = t.instructions
      chatModel = t.chatModel
      chatEffort = t.chatEffort
      plugins = t.plugins
    }

    func change(rename: Bool) -> AppStore.BotChange {
      AppStore.BotChange(
        name: rename ? name.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
        instructions: instructions, chatModel: chatModel, chatEffort: chatEffort, plugins: plugins,
        icon: icon, color: color)
    }
  }

  private var stored: Bot? { id.flatMap { store.bots[$0] } }
  private var isHatbot: Bool { id == Bot.hatbot }

  var body: some View {
    let changed = stored.map { Form($0) != form } ?? true
    SwiftUI.Form {
      if let error { Text(error).foregroundStyle(.red) }
      if id == nil, !templates.isEmpty {
        Section {
          Picker(
            "Template",
            selection: Binding(
              get: { template },
              set: { key in if form == filled { fill(key) } else { replacing = Pick(key: key) } })
          ) {
            Text("None").tag(String?.none)
            ForEach(templates) { Text($0.name).tag(String?.some($0.id)) }
          }
        }
      }
      Section {
        TextField("Name", text: $form.name).disabled(isHatbot)
      }
      Section("Icon") {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 40))], spacing: 8) {
          ForEach(Bot.Icon.allCases, id: \.self) { icon in
            Button { form.icon = icon } label: {
              Image(systemName: icon.symbol)
                .font(.title3)
                .foregroundStyle(form.color.color)
                .frame(width: 40, height: 40)
                .background(form.icon == icon ? Color.secondary.opacity(0.18) : .clear, in: .rect(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(icon.rawValue)
            .accessibilityAddTraits(form.icon == icon ? .isSelected : [])
          }
        }
        .padding(.vertical, 4)
      }
      Section("Colour") {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 40))], spacing: 8) {
          ForEach(Bot.Tint.allCases, id: \.self) { tint in
            Button { form.color = tint } label: {
              Circle()
                .fill(tint.color)
                .frame(width: 26, height: 26)
                .padding(4)
                .overlay { if form.color == tint { Circle().strokeBorder(Color.secondary, lineWidth: 1.5) } }
                .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(tint.rawValue)
            .accessibilityAddTraits(form.color == tint ? .isSelected : [])
          }
        }
        .padding(.vertical, 4)
      }
      Section("Role") {
        TextField(
          "Plans the week's meals around what's in the fridge. Keeps the shopping list.",
          text: $form.instructions, axis: .vertical
        )
        .lineLimit(4...16)
      }
      Section {
        Picker("Model", selection: $form.chatModel) {
          Text("As in Settings").tag(AppSettings.ChatModel?.none)
          Text("Haiku 5.5").tag(AppSettings.ChatModel?.some(.haiku))
          Text("Opus 5.5").tag(AppSettings.ChatModel?.some(.opus))
          // One set elsewhere that this app doesn't know: shown, and kept, as it is.
          if let m = form.chatModel, !AppSettings.ChatModel.known.contains(m) {
            Text(m.rawValue).tag(AppSettings.ChatModel?.some(m))
          }
        }
        Picker("Effort", selection: $form.chatEffort) {
          Text("As in Settings").tag(AppSettings.Effort?.none)
          Text("Low").tag(AppSettings.Effort?.some(.low))
          Text("Medium").tag(AppSettings.Effort?.some(.medium))
          if let e = form.chatEffort, !AppSettings.Effort.known.contains(e) {
            Text(e.rawValue.capitalized).tag(AppSettings.Effort?.some(e))
          }
        }
      }
      if !plugins.isEmpty {
        Section("Plugins") {
          Toggle(
            "Every plugin that's on",
            isOn: Binding(
              get: { form.plugins == nil },
              set: { form.plugins = $0 ? nil : plugins.map(\.id) }))
          if let on = form.plugins {
            ForEach(plugins) { p in
              Toggle(
                p.name,
                isOn: Binding(
                  get: { on.contains(p.id) },
                  set: { form.plugins = $0 ? on + [p.id] : on.filter { $0 != p.id } }))
            }
          }
        }
      }
      if let id, !isHatbot {
        Section {
          NavigationLink("Its notes", value: Route.memoryFile("bots/\(id)/INDEX.md"))
        }
        Section {
          Button("Delete \(stored?.name ?? "bot")", role: .destructive) { confirmDelete = true }
        } footer: {
          Text("Its chat and notes stay readable; its schedules and triggers go to Hatbot.")
        }
      }
    }
    .navigationTitle(id == nil ? "New bot" : stored?.name ?? "Bot")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if id == nil {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      ToolbarItem(placement: .confirmationAction) {
        Button(id == nil ? "Create" : "Save") { Task { await save() } }
          .disabled(busy || !changed || form.name.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .confirmationDialog(
      "Replace what you've written?",
      isPresented: Binding(get: { replacing != nil }, set: { if !$0 { replacing = nil } }),
      titleVisibility: .visible,
      presenting: replacing
    ) { pick in
      Button(pick.key == nil ? "Clear it" : "Use the template", role: .destructive) { fill(pick.key) }
      Button("Keep mine", role: .cancel) {}
    }
    .confirmationDialog("Delete \(stored?.name ?? "this bot")?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task {
          guard let id else { return }
          do {
            try await store.deleteBot(id)
            dismiss()
          } catch {
            self.error = message(for: error)
          }
        }
      }
    }
    .task(id: id) {
      if let stored {
        form = Form(stored)
      } else {
        // Only if you haven't started on it yet.
        if form == filled { fill(nil) }
        templates = await store.loadBotTemplates()
      }
      plugins = ((try? await store.loadPluginNames()) ?? []).sorted { $0.name < $1.name }
    }
  }

  /// A template picked, waiting for an answer.
  struct Pick: Identifiable {
    let key: String?
    var id: String { key ?? "" }
  }

  /// Fills the form from a template, or blank with a colour no other bot has.
  private func fill(_ key: String?) {
    template = key
    if let t = templates.first(where: { $0.id == key }) {
      form = Form(t)
    } else {
      form = Form()
      form.color = freeColor
    }
    filled = form
  }

  /// A new bot starts in a colour none of the others has yet.
  private var freeColor: Bot.Tint {
    let used = store.botIds.compactMap { store.bots[$0]?.color }
    return Bot.Tint.allCases.min { a, b in
      used.filter { $0 == a }.count < used.filter { $0 == b }.count
    } ?? .amber
  }

  private func save() async {
    busy = true
    defer { busy = false }
    error = nil
    do {
      if let id {
        form = Form(try await store.saveBot(id, form.change(rename: !isHatbot)))
        store.toast = "Saved"
      } else {
        let bot = try await store.createBot(form.change(rename: true))
        store.toast = "Made \(bot.name)"
        if let made { made(bot) } else { dismiss() }
      }
    } catch {
      self.error = message(for: error)
    }
  }
}
