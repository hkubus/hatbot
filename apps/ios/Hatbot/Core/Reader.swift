import Foundation

struct ReadTarget: Hashable, Sendable {
  var path: String?
  var file: Attachment?

  static func report(_ task: AgentTask, files: [Attachment]) -> ReadTarget? {
    let file = task.research == true ? files.first(where: \.isMarkdown) : nil
    if let path = task.reportPath { return ReadTarget(path: path, file: file) }
    return file.map { ReadTarget(file: $0) }
  }

  var name: String { path.map(MemoryTree.name) ?? file?.name ?? "" }
}

struct ReadFile: Equatable, Sendable {
  var text: String
  var name: String
  var note: String?
}

extension APIError {
  /// An older brain answers a missing memory file with a 400.
  var isGone: Bool { status == 404 || (status == 400 && message.hasPrefix("not found")) }
}

extension AppStore {
  func read(_ target: ReadTarget) async throws -> ReadFile {
    if let path = target.path {
      do {
        return ReadFile(text: try await memoryFile(path).content, name: MemoryTree.name(path), note: path)
      } catch let e as APIError where e.isGone && target.file != nil {}
    }
    guard let file = target.file else { throw APIError(status: 404, message: "Gone") }
    let data = try await api.data("/attachments/\(file.id)")
    return ReadFile(text: String(decoding: data, as: UTF8.self), name: file.name, note: nil)
  }
}
