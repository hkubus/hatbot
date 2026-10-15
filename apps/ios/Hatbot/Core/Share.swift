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

/// What the share sheet hands over, as one message: your note, then the text and links shared.
struct ShareDraft: Equatable, Sendable {
  var note = ""
  var texts: [String] = []
  var urls: [URL] = []

  var text: String {
    var parts = [note.trimmingCharacters(in: .whitespacesAndNewlines)]
    for t in texts {
      let t = t.trimmingCharacters(in: .whitespacesAndNewlines)
      // Safari shares a page's title as text with its link; the link says it.
      if !t.isEmpty && !urls.contains(where: { $0.absoluteString == t }) { parts.append(t) }
    }
    parts += urls.map(\.absoluteString)
    return parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
  }
}
