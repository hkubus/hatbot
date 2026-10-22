import Foundation

enum MemoryTree {
  /// The top level first, then folders by name.
  static func groups(_ files: [MemoryFile]) -> [(folder: String, files: [MemoryFile])] {
    let byFolder = Dictionary(grouping: files) { f in
      f.path.contains("/") ? String(f.path[..<f.path.lastIndex(of: "/")!]) : ""
    }
    return byFolder.keys
      .sorted { a, b in a.isEmpty || (!b.isEmpty && a < b) }
      .map { ($0, byFolder[$0]!.sorted { $0.path < $1.path }) }
  }

  static func name(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
  }

  static func newPath(_ input: String) -> String? {
    var p = input.trimmingCharacters(in: .whitespaces)
    while p.hasPrefix("/") { p.removeFirst() }
    if p.isEmpty || p.split(separator: "/").contains(where: { $0 == ".." || $0 == "." || $0 == ".git" }) {
      return nil
    }
    return p.hasSuffix(".md") ? p : p + ".md"
  }
}

struct DiffLine: Equatable, Sendable {
  enum Kind: Sendable { case added, removed, hunk, context }
  let kind: Kind
  let text: String

  static func parse(_ diff: String) -> [DiffLine] {
    let headers = ["diff --git", "index ", "--- ", "+++ ", "new file", "deleted file"]
    return diff.split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
      .filter { line in !headers.contains { line.hasPrefix($0) } }
      .map { line in
        let kind: Kind =
          line.hasPrefix("+") ? .added : line.hasPrefix("-") ? .removed : line.hasPrefix("@@") ? .hunk : .context
        return DiffLine(kind: kind, text: line)
      }
  }
}
