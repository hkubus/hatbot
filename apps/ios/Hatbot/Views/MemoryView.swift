// Memory (PLAN.md §7.2): the files by folder, a file to read and edit, the history with diffs and revert.
import SwiftUI

struct MemoryView: View {
  @Environment(AppStore.self) private var store
  @Binding var path: [Route]
  @State private var files: [MemoryFile]?
  @State private var error: String?
  @State private var naming = false
  @State private var newName = ""
  @State private var skills: [SkillStatus] = []
  /// The tidy-up ("") or skill fix being worked on; it arrives as proposal.updated.
  @State private var asking: String?
  /// The proposals there were when you asked, so the new one can be told apart.
  @State private var before = Set<Int>()

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let error {
          Text(error).foregroundStyle(.red)
        }
        let proposals = store.pendingProposals
        if !proposals.isEmpty {
          Section("To look over") {
            ForEach(proposals) { p in
              NavigationLink(value: Route.proposal(p)) { Label(p.title, systemImage: "wand.and.stars") }
            }
          }
        }
        let troubled = skills.filter { s in s.troubled && !proposals.contains { $0.skill == s.name } }
        if !troubled.isEmpty {
          Section("Skills that went wrong") {
            ForEach(troubled) { s in
              VStack(alignment: .leading, spacing: 6) {
                Text(s.name)
                Text(trouble(s)).font(.footnote).foregroundStyle(.secondary)
                Button(asking == s.name ? "Looking…" : "Suggest a fix") { fix(s.name) }
                  .disabled(asking != nil)
              }
            }
          }
        }
        ForEach(MemoryTree.groups(files ?? []), id: \.folder) { group in
          Section(group.folder.isEmpty ? "" : group.folder + "/") {
            ForEach(group.files) { f in
              NavigationLink(value: Route.memoryFile(f.path)) {
                Label(MemoryTree.name(f.path), systemImage: "doc.text")
              }
            }
          }
        }
      }
      .overlay { if files == nil && error == nil { ProgressView() } }
      .navigationTitle("Memory")
      .sidebarButton()
      .toolbar {
        ToolbarItem {
          NavigationLink(value: Route.memoryHistory(path: nil)) {
            Label("History", systemImage: "clock.arrow.circlepath")
          }
        }
        ToolbarItem {
          Button(asking == "" ? "Tidying…" : "Tidy up", systemImage: "wand.and.stars") { tidy() }
            .disabled(asking != nil)
        }
        ToolbarItem {
          Button("New file", systemImage: "plus") {
            newName = ""
            naming = true
          }
        }
      }
      .alert("New file", isPresented: $naming) {
        TextField("projects/garden.md", text: $newName)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button("Create") {
          // A file that's already there opens as it is, not as a blank new one over it.
          if let p = MemoryTree.newPath(newName) {
            path.append(.memoryFile(p, isNew: !(files ?? []).contains { $0.path == p }))
          }
        }
        Button("Cancel", role: .cancel) {}
      }
      .refreshable { await load() }
      .task(id: store.memoryVersion) { await load() }
      .onChange(of: store.proposals) { arrived() }
      .task(id: asking) {
        // Failures are told through ntfy; stop waiting after a while.
        guard asking != nil else { return }
        try? await Task.sleep(for: .seconds(180))
        if !Task.isCancelled { asking = nil }
      }
      .routes()
    }
  }

  private func load() async {
    await attempt($error) { files = try await store.memoryTree() }
    // Brains from before proposals answer 404; the files still show.
    try? await store.loadProposals()
    skills = (try? await store.loadSkills()) ?? []
  }

  private func trouble(_ s: SkillStatus) -> String {
    var parts: [String] = []
    if !s.failed.isEmpty { parts.append("\(s.failed.count) of \(s.runs) failed") }
    if !s.takeovers.isEmpty { parts.append("\(s.takeovers.count) needed you") }
    return parts.joined(separator: ", ")
  }

  /// A tidy-up of all of memory ("") or a fix to one skill, opened when it arrives.
  private func propose(_ asking: String, _ work: () async throws -> ProposalStarted) async {
    before = Set(store.proposals.keys)
    self.asking = asking
    do {
      let r = try await work()
      if r.started { return }
      if let p = r.proposal {
        store.proposals[p.id] = p
        path.append(.proposal(p))
      } else {
        store.toast = asking.isEmpty ? "Nothing to tidy" : "No fix found"
      }
    } catch {
      self.error = message(for: error)
    }
    self.asking = nil
  }

  /// The proposal asked for came in: open it.
  private func arrived() {
    guard let asking else { return }
    let p = store.pendingProposals.first { p in
      !before.contains(p.id) && (asking.isEmpty ? p.kind == .tidy : p.skill == asking)
    }
    guard let p else { return }
    self.asking = nil
    path.append(.proposal(p))
  }

  private func tidy() { Task { await propose("") { try await store.proposeTidy() } } }
  private func fix(_ name: String) { Task { await propose(name) { try await store.proposeSkillFix(name) } } }
}

/// A memory file: rendered to read, plain text to edit. Your saves are commits in your name.
struct MemoryFileView: View {
  let path: String
  var isNew = false
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var content: String?
  /// The version `content` is, which a save goes on top of: "" for a new file, nil from an older brain.
  @State private var baseSha: String?
  /// Saved elsewhere while you edited: the newer copy, until you reload it or overwrite it.
  @State private var conflict: AppStore.MemoryConflict?
  @State private var draft = ""
  @State private var editing = false
  @State private var saving = false
  @State private var confirmDelete = false
  @State private var error: String?

  var body: some View {
    Group {
      if editing {
        VStack(spacing: 0) {
          if let conflict { conflictBar(conflict) }
          TextEditor(text: $draft)
            .font(.system(.callout, design: .monospaced))
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .padding(.horizontal, 12)
        }
      } else if let content {
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            if let error { Text(error).foregroundStyle(.red) }
            MarkdownText(text: content)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding()
        }
      } else if let error {
        ContentUnavailableView(error, systemImage: "doc.questionmark")
      } else {
        ProgressView()
      }
    }
    .navigationTitle(MemoryTree.name(path))
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(editing)
    .toolbar {
      if editing {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            conflict = nil
            if isNew && content == nil { dismiss() } else { editing = false }
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { Task { await save() } }.disabled(saving || draft == content || conflict != nil)
        }
      } else if content != nil {
        ToolbarItem {
          Button("Edit") {
            draft = content ?? ""
            editing = true
          }
        }
        ToolbarItem(placement: .secondaryAction) {
          NavigationLink(value: Route.memoryHistory(path: path)) {
            Label("History", systemImage: "clock.arrow.circlepath")
          }
        }
        if path != "INDEX.md" {
          ToolbarItem(placement: .secondaryAction) {
            Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }
          }
        }
      }
    }
    .confirmationDialog(
      "Delete \(MemoryTree.name(path))? It stays in the history.", isPresented: $confirmDelete,
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) { Task { await delete() } }
    }
    .task(id: store.memoryVersion) {
      // Reload when memory changes elsewhere, unless you're editing it.
      guard !editing else { return }
      if isNew && content == nil {
        let title = MemoryTree.name(path).replacingOccurrences(of: ".md", with: "")
          .replacingOccurrences(of: "-", with: " ")
        draft = "# \(title.prefix(1).uppercased() + title.dropFirst())\n"
        // Saved only if there's still no file there.
        baseSha = ""
        editing = true
        return
      }
      await attempt($error) {
        let file = try await store.memoryFile(path)
        content = file.content
        baseSha = file.sha
      }
    }
  }

  /// What changed meanwhile, with Reload (theirs, in place of your edit) and Overwrite (yours over it).
  private func conflictBar(_ c: AppStore.MemoryConflict) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(content == nil ? "There's already a file here." : "Changed while you were editing.")
        .font(.subheadline.weight(.semibold))
      DisclosureGroup("The saved copy") {
        ScrollView {
          Text(c.content)
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 200)
      }
      .font(.subheadline)
      HStack {
        Button("Reload") {
          content = c.content
          draft = c.content
          baseSha = c.sha
          conflict = nil
        }
        Button("Overwrite") { Task { await save(over: c.sha) } }
      }
      .buttonStyle(.bordered)
      .disabled(saving)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(.fill.tertiary)
  }

  /// `over`: the version to replace, once you've chosen to overwrite one saved meanwhile.
  private func save(over: String? = nil) async {
    saving = true
    defer { saving = false }
    do {
      let sha = try await store.saveMemoryFile(path, content: draft, baseSha: over ?? baseSha)
      content = draft
      conflict = nil
      editing = false
      store.toast = sha.map { "Saved (\($0.prefix(7)))" } ?? "No changes"
    } catch let changed as AppStore.MemoryConflict {
      conflict = changed
    } catch {
      self.error = message(for: error)
      store.toast = message(for: error)
    }
  }

  private func delete() async {
    await attempt($error) {
      try await store.deleteMemoryFile(path)
      store.toast = "Deleted \(path)"
      dismiss()
    }
  }
}

/// Commits to the memory repo, all of them or one file's.
struct MemoryHistoryView: View {
  let path: String?
  @Environment(AppStore.self) private var store
  @State private var commits: [MemoryCommit]?
  @State private var error: String?

  var body: some View {
    List {
      if let error { Text(error).foregroundStyle(.red) }
      ForEach(commits ?? []) { c in
        NavigationLink(value: Route.commit(c)) {
          VStack(alignment: .leading, spacing: 3) {
            Text(c.message).lineLimit(2)
            Text("\(c.author) · \(c.date.stampText)").font(.footnote).foregroundStyle(.secondary)
          }
        }
      }
    }
    .overlay { if commits == nil && error == nil { ProgressView() } }
    .navigationTitle(path.map(MemoryTree.name) ?? "History")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await load() }
    .task(id: store.memoryVersion) { await load() }
  }

  private func load() async {
    await attempt($error) { commits = try await store.memoryLog(path: path) }
  }
}

/// One commit's diff, with Revert.
struct CommitView: View {
  let commit: MemoryCommit
  @Environment(AppStore.self) private var store
  @State private var lines: [DiffLine]?
  @State private var confirmRevert = false
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        Text(commit.message).font(.headline)
        Text("\(commit.author) · \(commit.files.joined(separator: ", ")) · \(commit.date.stampText)")
          .font(.footnote).foregroundStyle(.secondary)
        if let error { Text(error).foregroundStyle(.red) }
        if let lines {
          DiffLines(lines: lines)
        } else {
          ProgressView()
        }
      }
      .padding()
    }
    .navigationTitle(String(commit.sha.prefix(7)))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem {
        Button("Revert", systemImage: "arrow.uturn.backward") { confirmRevert = true }
      }
    }
    .confirmationDialog("Revert “\(commit.message)”?", isPresented: $confirmRevert, titleVisibility: .visible) {
      Button("Revert", role: .destructive) {
        Task {
          await attempt($error) {
            let sha = try await store.revert(commit.sha)
            store.toast = sha.map { "Reverted. New commit \($0.prefix(7))" } ?? "Nothing to revert"
          }
        }
      }
    }
    .task(id: commit.sha) {
      await attempt($error) { lines = DiffLine.parse(try await store.memoryDiff(commit.sha)) }
    }
  }
}
