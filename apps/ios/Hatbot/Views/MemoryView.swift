// Memory (PLAN.md §7.2): the files by folder, a file to read and edit, the history with diffs and revert.
import SwiftUI

struct MemoryView: View {
  @Environment(AppStore.self) private var store
  @State private var path: [Route] = []
  @State private var files: [MemoryFile]?
  @State private var error: String?
  @State private var naming = false
  @State private var newName = ""

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let error {
          Text(error).foregroundStyle(.red)
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
      .toolbar {
        ToolbarItem {
          NavigationLink(value: Route.memoryHistory(path: nil)) {
            Label("History", systemImage: "clock.arrow.circlepath")
          }
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
          if let p = MemoryTree.newPath(newName) { path.append(.memoryFile(p, isNew: true)) }
        }
        Button("Cancel", role: .cancel) {}
      }
      .refreshable { await load() }
      .task(id: store.memoryVersion) { await load() }
      .routes()
    }
  }

  private func load() async {
    do {
      files = try await store.memoryTree()
      error = nil
    } catch {
      self.error = message(for: error)
    }
  }
}

/// A memory file: rendered to read, plain text to edit. Your saves are commits in your name.
struct MemoryFileView: View {
  let path: String
  var isNew = false
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var content: String?
  @State private var draft = ""
  @State private var editing = false
  @State private var saving = false
  @State private var confirmDelete = false
  @State private var error: String?

  var body: some View {
    Group {
      if editing {
        TextEditor(text: $draft)
          .font(.system(.callout, design: .monospaced))
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .padding(.horizontal, 12)
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
            if isNew && content == nil { dismiss() } else { editing = false }
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { Task { await save() } }.disabled(saving || draft == content)
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
        editing = true
        return
      }
      do {
        content = try await store.memoryFile(path)
        error = nil
      } catch {
        self.error = message(for: error)
      }
    }
  }

  private func save() async {
    saving = true
    defer { saving = false }
    do {
      let sha = try await store.saveMemoryFile(path, content: draft)
      content = draft
      editing = false
      store.toast = sha.map { "Saved (\($0.prefix(7)))" } ?? "No changes"
    } catch {
      self.error = message(for: error)
      store.toast = message(for: error)
    }
  }

  private func delete() async {
    do {
      try await store.deleteMemoryFile(path)
      store.toast = "Deleted \(path)"
      dismiss()
    } catch {
      self.error = message(for: error)
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
    do {
      commits = try await store.memoryLog(path: path)
      error = nil
    } catch {
      self.error = message(for: error)
    }
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
          do {
            let sha = try await store.revert(commit.sha)
            store.toast = sha.map { "Reverted. New commit \($0.prefix(7))" } ?? "Nothing to revert"
          } catch {
            self.error = message(for: error)
          }
        }
      }
    }
    .task(id: commit.sha) {
      do {
        lines = DiffLine.parse(try await store.memoryDiff(commit.sha))
      } catch {
        self.error = message(for: error)
      }
    }
  }
}
