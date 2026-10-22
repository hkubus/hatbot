import Foundation

struct AskResult: Decodable, Sendable {
  var message: ThreadMessage
  var replies: [ThreadMessage]
  var finished: Bool

  var answer: String {
    let text = replies.map { Markdown.plain($0.text) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    if !finished { return text.isEmpty ? "Hatbot is still on it. The answer will be in the chat." : text }
    return text.isEmpty ? "Hatbot didn't answer." : text
  }
}

/// The shared text, which someone else wrote, goes as a file so Hatbot treats it as untrusted, not as your words.
struct ShareDraft: Equatable, Sendable {
  static let sharedName = "Shared text.txt"

  var note = ""
  var texts: [String] = []
  var urls: [URL] = []

  var text: String {
    let parts = [note.trimmingCharacters(in: .whitespacesAndNewlines)] + urls.map(\.absoluteString)
    return parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
  }

  var sharedTexts: [String] {
    texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      // Safari shares a page's title as text with its link; the link says it.
      .filter { t in !t.isEmpty && !urls.contains(where: { $0.absoluteString == t }) }
  }

  var shared: String { sharedTexts.joined(separator: "\n\n") }

  var isEmpty: Bool { text.isEmpty && shared.isEmpty }

  /// A message takes 10 attachments, and the shared text is one of them.
  var fileRoom: Int { shared.isEmpty ? 10 : 9 }
}
