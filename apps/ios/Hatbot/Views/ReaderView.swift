// A Markdown file to read, such as a research report: rendered as replies are, in a column that stays
// readable on an iPad, with Edit for a note and Share for the file.
import SwiftUI

struct ReaderView: View {
  let target: ReadTarget
  @Environment(AppStore.self) private var store
  @State private var file: ReadFile?
  /// The text as a file under its own name, for Share.
  @State private var shared: URL?
  @State private var gone = false
  @State private var failed = false
  @State private var tries = 0

  var body: some View {
    Group {
      if let file {
        ScrollView {
          MarkdownText(text: file.text)
            .frame(maxWidth: 680, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
      } else if gone {
        ContentUnavailableView("This file is gone.", systemImage: "doc.questionmark")
      } else if failed {
        ContentUnavailableView {
          Label("Couldn't open this file.", systemImage: "exclamationmark.triangle")
        } description: {
          EmptyView()
        } actions: {
          Button("Retry") {
            failed = false
            tries += 1
          }
        }
      } else {
        ProgressView()
      }
    }
    .navigationTitle(file?.name ?? target.name)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let note = file?.note {
        ToolbarItem {
          NavigationLink(value: Route.memoryFile(note, edit: true)) { Text("Edit") }
        }
      }
      if let shared {
        ToolbarItem { ShareLink(item: shared) }
      }
    }
    // A note is read again when memory changes, e.g. after you edit it.
    .task(id: Reload(tries: tries, memory: target.path == nil ? 0 : store.memoryVersion)) { await load() }
  }

  private struct Reload: Hashable {
    let tries: Int
    let memory: Int
  }

  private func load() async {
    do {
      let read = try await store.read(target)
      file = read
      gone = false
      failed = false
      shared = try? save(read)
    } catch {
      if Task.isCancelled { return }
      // A file already shown stays up when reading it again fails.
      guard file == nil else { return }
      if (error as? APIError)?.isGone == true { gone = true } else { failed = true }
    }
  }

  /// The text in a file named as it is, which signing out deletes with the other opened files.
  private func save(_ read: ReadFile) throws -> URL {
    let dir = DiskCache.openedFiles.appendingPathComponent("read", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var name = read.name.replacingOccurrences(of: "/", with: "_")
    if !name.lowercased().hasSuffix(".md") { name += ".md" }
    let url = dir.appendingPathComponent(name)
    try Data(read.text.utf8).write(to: url, options: .atomic)
    return url
  }
}
