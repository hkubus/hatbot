import Foundation

struct DiskCache: Sendable {
  let dir: URL

  /// Reads, writes and clearing take turns here, so a write still on its way can't bring back what
  /// signing out cleared.
  private static let queue = DispatchQueue(label: "hatbot.disk-cache", qos: .userInitiated)

  /// Files opened from the chat, saved for Quick Look under their own names; signing out deletes them.
  static let openedFiles = FileManager.default.temporaryDirectory.appendingPathComponent("attachments", isDirectory: true)

  struct Chats: Codable, Equatable, Sendable {
    var bots: [Bot]
    var conversations: [Conversation]
    var conversationId: Int
  }

  struct Page: Codable, Equatable, Sendable {
    var messages: [ThreadMessage]
    var episodes: [Episode]
    var hasEarlier: Bool
    /// Its messages' tasks, as cards; files from before them have none.
    var tasks: [AgentTask] = []
  }

  func chats() -> Chats? { load("chats.json") }

  func page(_ conversationId: Int) -> Page? { load("page-\(conversationId).json") }

  func save(_ chats: Chats) { write(chats, "chats.json") }

  func save(_ page: Page, for conversationId: Int) { write(page, "page-\(conversationId).json") }

  func forget(_ conversationId: Int) {
    let url = dir.appendingPathComponent("page-\(conversationId).json")
    Self.queue.async { try? FileManager.default.removeItem(at: url) }
  }

  /// Done once the writes before it are.
  func clear() {
    let dir = dir
    Self.queue.sync { try? FileManager.default.removeItem(at: dir) }
  }

  private func load<T: Decodable>(_ name: String) -> T? {
    let url = dir.appendingPathComponent(name)
    guard let data = Self.queue.sync(execute: { try? Data(contentsOf: url) }) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  private func write<T: Encodable>(_ value: T, _ name: String) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    let dir = dir
    Self.queue.async {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try? data.write(to: dir.appendingPathComponent(name), options: .atomic)
    }
  }
}

extension DiskCache {
  func memoryTree() -> [MemoryFile]? { load("memory-tree.json") }

  func save(memoryTree: [MemoryFile]) { write(memoryTree, "memory-tree.json") }

  func todos() -> TodoList? { load("todo.json") }

  func save(_ todos: TodoList) { write(todos, "todo.json") }
}

extension DiskCache {
  /// `list`: "active" or "done".
  func tasks(_ list: String) -> [AgentTask]? { load("tasks-\(list).json") }

  func save(tasks: [AgentTask], _ list: String) { write(tasks, "tasks-\(list).json") }
}

extension DiskCache.Page {
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    messages = try c.decode([ThreadMessage].self, forKey: .messages)
    episodes = try c.decode([Episode].self, forKey: .episodes)
    hasEarlier = try c.decode(Bool.self, forKey: .hasEarlier)
    tasks = try c.decodeIfPresent([AgentTask].self, forKey: .tasks) ?? []
  }
}
