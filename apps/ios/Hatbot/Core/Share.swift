// Sending to Hatbot from outside the app: Siri and Shortcuts (App Intents) and the share sheet.
import Foundation

/// POST /thread/ask: your message, and the replies to it once they're done or the wait ran out.
struct AskResult: Decodable, Sendable {
  var message: ThreadMessage
  var replies: [ThreadMessage]
  var finished: Bool

  /// What Siri says: the replies without their Markdown, or that the answer will be in the chat.
  var answer: String {
    let text = replies.map { Markdown.plain($0.text) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    if !finished { return text.isEmpty ? "Hatbot is still on it. The answer will be in the chat." : text }
    return text.isEmpty ? "Hatbot didn't answer." : text
  }
}

/// What the share sheet hands over: your note and the links shared, as your message; the text shared,
/// which someone else wrote, goes with it as a file, so Hatbot treats it as untrusted, not as your words.
struct ShareDraft: Equatable, Sendable {
  /// The file the shared text goes in.
  static let sharedName = "Shared text.txt"

  var note = ""
  var texts: [String] = []
  var urls: [URL] = []

  var text: String {
    let parts = [note.trimmingCharacters(in: .whitespacesAndNewlines)] + urls.map(\.absoluteString)
    return parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
  }

  /// The texts that go in the file, as the share sheet lists them.
  var sharedTexts: [String] {
    texts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      // Safari shares a page's title as text with its link; the link says it.
      .filter { t in !t.isEmpty && !urls.contains(where: { $0.absoluteString == t }) }
  }

  var shared: String { sharedTexts.joined(separator: "\n\n") }

  var isEmpty: Bool { text.isEmpty && shared.isEmpty }

  /// How many files go with it: a message takes 10 attachments, and the shared text is one of them.
  var fileRoom: Int { shared.isEmpty ? 10 : 9 }
}
