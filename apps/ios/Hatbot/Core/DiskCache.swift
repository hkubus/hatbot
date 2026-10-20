// What the app last saw, kept on disk: the bots and chats, and the latest page of each chat. A cold
// launch shows them straight away, and the brain's answers replace them as they come.
import Foundation

struct DiskCache: Sendable {
  let dir: URL

  /// Reads, writes and clearing take turns here, so a write still on its way can't bring back what
  /// signing out cleared.
  private static let queue = DispatchQueue(label: "hatbot.disk-cache", qos: .userInitiated)

  /// Files opened from the chat, saved for Quick Look under their own names; signing out deletes them.
  static let openedFiles = FileManager.default.temporaryDirectory.appendingPathComponent("attachments", isDirectory: true)

  /// The bots and chats, and which chat was open.
  struct Chats: Codable, Equatable, Sendable {
    var bots: [Bot]
    var conversations: [Conversation]
    var conversationId: Int
  }

  /// A chat's latest page.
  struct Page: Codable, Equatable, Sendable {
    var messages: [ThreadMessage]
    var episodes: [Episode]
    var hasEarlier: Bool
  }

  func chats() -> Chats? { load("chats.json") }

  func page(_ conversationId: Int) -> Page? { load("page-\(conversationId).json") }

  func save(_ chats: Chats) { write(chats, "chats.json") }

  func save(_ page: Page, for conversationId: Int) { write(page, "page-\(conversationId).json") }

  /// A chat that was deleted.
  func forget(_ conversationId: Int) {
    let url = dir.appendingPathComponent("page-\(conversationId).json")
    Self.queue.async { try? FileManager.default.removeItem(at: url) }
  }

  /// Signing out leaves nothing behind. Done once the writes before it are.
  func clear() {
    let dir = dir
    Self.queue.sync { try? FileManager.default.removeItem(at: dir) }
  }

  private func load<T: Decodable>(_ name: String) -> T? {
    let url = dir.appendingPathComponent(name)
    guard let data = Self.queue.sync(execute: { try? Data(contentsOf: url) }) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  /// Encoded here, written off the main thread.
  private func write<T: Encodable>(_ value: T, _ name: String) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    let dir = dir
    Self.queue.async {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try? data.write(to: dir.appendingPathComponent(name), options: .atomic)
    }
  }
}

/// Memory's files and the to-do list, so their pages show at once on launch and refresh when opened.
extension DiskCache {
  func memoryTree() -> [MemoryFile]? { load("memory-tree.json") }

  func save(memoryTree: [MemoryFile]) { write(memoryTree, "memory-tree.json") }

  func todos() -> TodoList? { load("todo.json") }

  func save(_ todos: TodoList) { write(todos, "todo.json") }
}
