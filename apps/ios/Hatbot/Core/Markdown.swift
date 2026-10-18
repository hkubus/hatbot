// Splits Hatbot's Markdown into blocks; the views render inline formatting with AttributedString.
// Covers what replies use: headings, paragraphs, lists, quotes, fenced code, charts, tables and rules.
// An unclosed fence (a reply still streaming) runs to the end.
import Foundation

enum MDBlock: Equatable, Sendable {
  struct Item: Equatable, Sendable {
    /// Nesting depth, from the item's indentation.
    var depth: Int
    /// "•", or "3." for an ordered item.
    var marker: String
    var text: String
  }

  case heading(level: Int, text: String)
  case paragraph(String)
  case list([Item])
  case quote(String)
  case code(language: String?, code: String)
  /// A ```chart block that checks out; one that doesn't stays code.
  case chart(ChartSpec)
  /// A ```chart block whose values are in a file, fetched when it's shown.
  case chartFile(ChartFile)
  /// A ```chart block still streaming in.
  case chartPending
  case table(header: [String], rows: [[String]])
  case rule
}

/// A value in an NSCache, which keeps objects.
final class CacheBox<T: Sendable>: @unchecked Sendable {
  let value: T
  init(_ value: T) { self.value = value }
}

enum Markdown {
  /// Parsed blocks by text: the chat redraws messages it has parsed already as you scroll.
  nonisolated(unsafe) private static let cache: NSCache<NSString, CacheBox<[MDBlock]>> = {
    let c = NSCache<NSString, CacheBox<[MDBlock]>>()
    c.countLimit = 400
    return c
  }()

  /// `parse`, remembered.
  static func cached(_ source: String) -> [MDBlock] {
    let key = NSString(string: source)
    if let hit = cache.object(forKey: key) { return hit.value }
    let blocks = parse(source)
    cache.setObject(CacheBox(blocks), forKey: key)
    return blocks
  }

  /// The text without its Markdown, for Siri to say and VoiceOver to read.
  static func plain(_ source: String) -> String {
    cached(source).map { block -> String in
      switch block {
      case let .heading(_, text), let .paragraph(text), let .quote(text): inline(text)
      case let .list(items):
        items.map { ($0.marker == "•" ? "" : "\($0.marker) ") + inline($0.text) }.joined(separator: "\n")
      case let .code(_, code): code
      case let .chart(spec): spec.title ?? "A chart."
      case let .chartFile(file): file.title ?? "A chart."
      case .chartPending, .rule: ""
      case let .table(header, rows):
        ([header] + rows).map { $0.map(inline).joined(separator: ", ") }.joined(separator: "\n")
      }
    }
    .filter { !$0.isEmpty }
    .joined(separator: "\n\n")
  }

  /// A line without links' addresses or emphasis and code marks.
  static func inline(_ text: String) -> String {
    var s = text.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
    s = s.replacingOccurrences(of: #"\*\*|__|~~|`"#, with: "", options: .regularExpression)
    return s.replacingOccurrences(
      of: #"(?<![\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])"#, with: "$1", options: .regularExpression)
  }

  static func parse(_ source: String) -> [MDBlock] {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var blocks: [MDBlock] = []
    var paragraph: [String] = []
    var i = 0

    func flush() {
      if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
      paragraph = []
    }

    while i < lines.count {
      let line = lines[i]
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      if trimmed.isEmpty {
        flush()
        i += 1
        continue
      }

      if let fence = fenceMarker(trimmed) {
        flush()
        let language = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
        var code: [String] = []
        i += 1
        while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
          code.append(lines[i])
          i += 1
        }
        let closed = i < lines.count
        i += 1
        let source = code.joined(separator: "\n")
        if language == "chart" {
          if let spec = ChartSpec.parse(source) {
            blocks.append(.chart(spec))
            continue
          }
          if let file = ChartFile.parse(source) {
            blocks.append(.chartFile(file))
            continue
          }
          if !closed {
            blocks.append(.chartPending)
            continue
          }
        }
        blocks.append(.code(language: language.isEmpty ? nil : language, code: source))
        continue
      }

      if let (level, text) = heading(trimmed) {
        flush()
        blocks.append(.heading(level: level, text: text))
        i += 1
        continue
      }

      if isRule(trimmed) {
        flush()
        blocks.append(.rule)
        i += 1
        continue
      }

      if trimmed.hasPrefix(">") {
        flush()
        var quoted: [String] = []
        while i < lines.count {
          let t = lines[i].trimmingCharacters(in: .whitespaces)
          guard t.hasPrefix(">") else { break }
          quoted.append(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))
          i += 1
        }
        blocks.append(.quote(quoted.joined(separator: "\n")))
        continue
      }

      if listItem(line) != nil {
        flush()
        var items: [MDBlock.Item] = []
        while i < lines.count {
          if let item = listItem(lines[i]) {
            items.append(item)
          } else if !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, lines[i].hasPrefix("  "), !items.isEmpty {
            // A wrapped line continues the item above.
            items[items.count - 1].text += "\n" + lines[i].trimmingCharacters(in: .whitespaces)
          } else {
            break
          }
          i += 1
        }
        blocks.append(.list(items))
        continue
      }

      if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableDivider(lines[i + 1]) {
        flush()
        let header = cells(trimmed)
        var rows: [[String]] = []
        i += 2
        while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
          rows.append(cells(lines[i]))
          i += 1
        }
        blocks.append(.table(header: header, rows: rows))
        continue
      }

      paragraph.append(trimmed)
      i += 1
    }
    flush()
    return blocks
  }

  private static func fenceMarker(_ t: String) -> String? {
    if t.hasPrefix("```") { return "```" }
    if t.hasPrefix("~~~") { return "~~~" }
    return nil
  }

  private static func heading(_ t: String) -> (Int, String)? {
    let hashes = t.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes), t.dropFirst(hashes).first == " " else { return nil }
    return (hashes, t.dropFirst(hashes).trimmingCharacters(in: .whitespaces))
  }

  private static func isRule(_ t: String) -> Bool {
    let chars = t.filter { $0 != " " }
    guard chars.count >= 3, let first = chars.first, "-*_".contains(first) else { return false }
    return chars.allSatisfy { $0 == first }
  }

  private static func listItem(_ line: String) -> MDBlock.Item? {
    let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
    let t = line.trimmingCharacters(in: .whitespaces)
    let depth = indent / 2
    for bullet in ["- ", "* ", "+ "] where t.hasPrefix(bullet) {
      let rest = String(t.dropFirst(2))
      if rest.hasPrefix("[ ] ") { return .init(depth: depth, marker: "☐", text: String(rest.dropFirst(4))) }
      if rest.hasPrefix("[x] ") || rest.hasPrefix("[X] ") {
        return .init(depth: depth, marker: "☑", text: String(rest.dropFirst(4)))
      }
      return .init(depth: depth, marker: "•", text: rest)
    }
    let digits = t.prefix { $0.isASCII && $0.isNumber }
    guard !digits.isEmpty, digits.count <= 9 else { return nil }
    let after = t.dropFirst(digits.count)
    guard let dot = after.first, dot == "." || dot == ")", after.dropFirst().first == " " else { return nil }
    return .init(depth: depth, marker: "\(digits).", text: String(after.dropFirst(2)))
  }

  private static func isTableDivider(_ line: String) -> Bool {
    let t = line.trimmingCharacters(in: .whitespaces)
    return t.hasPrefix("|") && t.contains("-") && t.allSatisfy { "|-: ".contains($0) }
  }

  private static func cells(_ line: String) -> [String] {
    var t = line.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("|") { t.removeFirst() }
    if t.hasSuffix("|") { t.removeLast() }
    return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
  }
}
