import Foundation

/// A script's steps in words, as describeSteps in packages/shared/src/script.ts writes them.
enum ScriptSteps {
  /// Numbered lines, nested steps indented.
  static func lines(_ steps: [JSONValue]) -> [String] {
    var lines: [String] = []
    var n = 0
    func walk(_ list: [JSONValue], _ depth: Int) {
      let pad = String(repeating: "  ", count: depth)
      for s in list {
        n += 1
        lines.append("\(n). \(pad)\(step(s))")
        if s["if"] != nil {
          walk(s["do"]?.list ?? [], depth + 1)
          if let other = s["else"]?.list, !other.isEmpty {
            lines.append("   \(pad)Otherwise:")
            walk(other, depth + 1)
          }
        } else if s["each"] != nil {
          walk(s["do"]?.list ?? [], depth + 1)
        }
      }
    }
    walk(steps, 0)
    return lines
  }

  private static func step(_ s: JSONValue) -> String {
    if let call = s["call"] {
      var line = "Call \(call.string ?? call.json)"
      if let input = s["input"], case let .object(o) = input, !o.isEmpty { line += " with \(input.json)" }
      if let name = s["as"]?.string { line += ", as \(name)" }
      if s["optional"] == .bool(true) { line += ", going on if it fails" }
      return line
    }
    if let c = s["if"] { return "If \(condition(c)):" }
    if let each = s["each"] { return "For each \(text(s["as"])) in \(text(each)):" }
    if let set = s["set"] { return "Set \(text(set)) to \(shown(s["to"]))" }
    if let add = s["add"] { return "Add \(shown(s["value"])) to \(text(add))" }
    if let notify = s["notify"] { return "Tell you: \(text(notify))" }
    if let post = s["post"] { return "Note in the chat: \(text(post))" }
    if let task = s["task"] {
      let title = s["title"]?.string.map { " \"\($0)\"" } ?? ""
      return "Start a task\(title): \(text(task))"
    }
    if let stop = s["stop"] { return "\(s["failed"] == .bool(true) ? "Fail" : "Stop"): \(text(stop))" }
    return s.json
  }

  private static let words = [
    "equals": "equals", "not_equals": "doesn't equal", "above": "is above", "below": "is below",
    "contains": "contains", "not_contains": "doesn't contain", "matches": "matches", "empty": "is empty",
    "not_empty": "isn't empty",
  ]

  static func condition(_ c: JSONValue) -> String {
    if let all = c["all"]?.list { return all.map { "(\(condition($0)))" }.joined(separator: " and ") }
    if let any = c["any"]?.list { return any.map { "(\(condition($0)))" }.joined(separator: " or ") }
    if let not = c["not"] { return "not (\(condition(not)))" }
    let check = c["is"]?.string ?? ""
    let left = "\(shown(c["value"])) \(words[check] ?? check.replacingOccurrences(of: "_", with: " "))"
    return check == "empty" || check == "not_empty" ? left : "\(left) \(shown(c["to"]))"
  }

  /// A value as written: a {{reference}} as it is, other text in quotes, the rest as JSON.
  private static func shown(_ v: JSONValue?) -> String {
    guard let v else { return "null" }
    guard let s = v.string else { return v.json }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.wholeMatch(of: #/\{\{[^{}]+\}\}/#) != nil ? t : "\"\(s)\""
  }

  private static func text(_ v: JSONValue?) -> String { v?.string ?? v?.json ?? "" }

  /// What you type for an input: JSON where it reads as JSON, text otherwise.
  static func typed(_ text: String) -> JSONValue {
    (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .string(text)
  }
}

extension JSONValue {
  fileprivate var list: [JSONValue]? {
    if case let .array(a) = self { a } else { nil }
  }
}
