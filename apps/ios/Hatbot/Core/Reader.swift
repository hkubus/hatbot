// The reader: a Markdown file to read, from the notes or attached to a message or task. A research
// report is kept both ways, so its attached copy stands in when the note is gone.
import Foundation

/// What the reader opens: a note (`path`), else an attachment (`file`); with both, the attachment when
/// the note is gone.
struct ReadTarget: Hashable, Sendable {
  var path: String?
  var file: Attachment?

  /// Where a task's report opens: its note, or the Markdown file attached to a research task.
  static func report(_ task: AgentTask, files: [Attachment]) -> ReadTarget? {
    let file = task.research == true ? files.first(where: \.isMarkdown) : nil
    if let path = task.reportPath { return ReadTarget(path: path, file: file) }
    return file.map { ReadTarget(file: $0) }
  }

  /// Its name before it's read.
  var name: String { path.map(MemoryTree.name) ?? file?.name ?? "" }
}

/// A file read, and the note it is, if it's one (Edit opens that).
struct ReadFile: Equatable, Sendable {
  var text: String
  var name: String
  var note: String?
}

extension APIError {
  /// Not there: a 404, or an older brain's 400 for a missing memory file.
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
