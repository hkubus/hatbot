// What the app last saw, kept on disk: the bots and chats, and the latest page of each chat. A cold
// launch shows them straight away, and the brain's answers replace them as they come.
import Foundation

struct DiskCache: Sendable {
  let dir: URL

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

  /// Signing out leaves nothing behind.
  func clear() {
    try? FileManager.default.removeItem(at: dir)
  }

  private func load<T: Decodable>(_ name: String) -> T? {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  /// Encoded here, written off the main thread.
  private func write<T: Encodable>(_ value: T, _ name: String) {
    guard let data = try? JSONEncoder().encode(value) else { return }
    let dir = dir
    Task.detached(priority: .utility) {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try? data.write(to: dir.appendingPathComponent(name), options: .atomic)
    }
  }
}
