// A group chat's page (PLAN.md §14.4): its name and bots. No id makes one.
import SwiftUI

struct GroupView: View {
  let id: Int?
  /// After making one.
  var made: ((Conversation) -> Void)?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var members: [String] = []
  @State private var busy = false
  @State private var confirmDelete = false
  @State private var error: String?

  /// Most bots in a group, besides you (MAX_GROUP_BOTS in packages/shared).
  private static let most = 6

  private var stored: Conversation? { id.flatMap { id in store.conversations.first { $0.id == id } } }

  var body: some View {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let changed = stored.map { trimmed != ($0.title ?? "") || members != $0.botIds } ?? true
    let valid = (2...Self.most).contains(members.count)
    Form {
      if let error { Text(error).foregroundStyle(.red) }
      Section {
        TextField("Name", text: $title)
      }
      Section {
        ForEach(store.botIds, id: \.self) { b in
          Toggle(
            store.botName(b),
            isOn: Binding(
              get: { members.contains(b) },
              set: { on in
                if on { members.append(b) } else { members.removeAll { $0 == b } }
              }))
        }
      } header: {
        Text("Bots, 2 to \(Self.most)")
      }
      if id != nil {
        Section {
          Button("Delete group", role: .destructive) { confirmDelete = true }
        }
      }
    }
    .navigationTitle(id == nil ? "New group" : store.chatName(stored))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if id == nil {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      ToolbarItem(placement: .confirmationAction) {
        Button(id == nil ? "Create" : "Save") { Task { await save(trimmed) } }
          .disabled(busy || !changed || !valid)
      }
    }
    .confirmationDialog("Delete \(store.chatName(stored))? Its messages go with it.", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task {
          guard let id else { return }
          do {
            try await store.deleteGroup(id)
            dismiss()
          } catch {
            self.error = message(for: error)
          }
        }
      }
    }
    .task(id: id) {
      if let stored {
        title = stored.title ?? ""
        members = stored.botIds
      }
    }
  }

  private func save(_ title: String) async {
    busy = true
    defer { busy = false }
    error = nil
    let change = AppStore.GroupChange(title: title, botIds: members)
    do {
      if let id {
        try await store.saveGroup(id, change)
        store.toast = "Saved"
      } else {
        let c = try await store.createGroup(change)
        if let made { made(c) } else { dismiss() }
      }
    } catch {
      self.error = message(for: error)
    }
  }
}
