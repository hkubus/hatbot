import SwiftUI

/// Your own computers, through Hatbot's desktop app. Only the computer turns its use on; here it can be
/// paused or turned off.
struct ComputersView: View {
  @Environment(AppStore.self) private var store
  /// Nil until loaded; false while the Your computers plugin is off.
  @State private var on: Bool?
  @State private var error: String?
  @State private var busy = false
  /// Careful switches as moved, until saved.
  @State private var careful: [String: Bool] = [:]
  @State private var renaming: ComputerInfo?
  @State private var newName = ""
  @State private var turningOff: ComputerInfo?
  @State private var forgetting: ComputerInfo?

  var body: some View {
    TiledForm {
      if let error { Text(error).foregroundStyle(Color.danger) }
      if on == false {
        Text("The Your computers plugin is off.").foregroundStyle(.secondary)
      } else if on == true && store.computers.isEmpty {
        Text(
          "None yet. Install Hatbot's desktop app on a computer, sign in, and switch on “Let Hatbot use this computer” there."
        )
        .foregroundStyle(.secondary)
      }
      ForEach(store.computers) { c in
        Section {
          LabeledContent(c.name, value: state(c))
          Toggle(
            "Ask before every command and file outside Downloads",
            isOn: .saving(c.careful, shown: shownCareful(c.id)) { value in
              await attempt($error) { try await store.setCareful(c.id, value) }
            })
          if c.online && c.enabled {
            Button(c.paused ? "Resume" : "Pause") { act { try await store.pauseComputer(c.id, !c.paused) } }
            Button("Turn off") { turningOff = c }
          }
          Button("Rename") {
            newName = c.name
            renaming = c
          }
          Button("Forget", role: .destructive) { forgetting = c }
        }
        .disabled(busy)
      }
    }
    .overlay { if on == nil && error == nil && store.computers.isEmpty { ProgressView() } }
    .navigationTitle("Your computers")
    .navigationBarTitleDisplayMode(.inline)
    .alert(
      "Rename \(renaming?.name ?? "")",
      isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
      presenting: renaming
    ) { c in
      TextField(c.name, text: $newName)
      Button("Rename") {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { act { try await store.renameComputer(c.id, to: name) } }
      }
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog(
      "Turn off Hatbot's use of \(turningOff?.name ?? "")?",
      isPresented: Binding(get: { turningOff != nil }, set: { if !$0 { turningOff = nil } }),
      titleVisibility: .visible,
      presenting: turningOff
    ) { c in
      Button("Turn off", role: .destructive) { act { try await store.turnOffComputer(c.id) } }
    } message: { _ in
      Text("Only the computer can turn it on again.")
    }
    .confirmationDialog(
      "Forget \(forgetting?.name ?? "")?",
      isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
      titleVisibility: .visible,
      presenting: forgetting
    ) { c in
      Button("Forget", role: .destructive) { act { try await store.forgetComputer(c.id) } }
    } message: { _ in
      Text("If its app is still signed in, it comes back as new.")
    }
    .task { await load() }
    .refreshable { await load() }
  }

  private func state(_ c: ComputerInfo) -> String {
    if !c.online { return "Offline" }
    if !c.enabled { return "Off: switch it on in Hatbot's app there" }
    if c.paused { return "Paused" }
    if c.locked { return "Locked" }
    return "Online"
  }

  private func shownCareful(_ id: String) -> Binding<Bool?> {
    Binding(get: { careful[id] }, set: { careful[id] = $0 })
  }

  private func act(_ work: @escaping @MainActor () async throws -> Void) {
    Task {
      busy = true
      await attempt($error) { try await work() }
      busy = false
    }
  }

  private func load() async {
    await attempt($error) { on = try await store.loadComputers() }
  }
}
