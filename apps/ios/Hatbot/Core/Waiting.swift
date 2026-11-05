// What waits on you (apps/web/src/waiting.ts).
import Foundation

enum Waiting {
  /// The app's badge and the widget's count: approvals to answer, not what the review blocked or a
  /// message on its way; questions; and screens asking you to take over.
  static func count(
    approvals: some Sequence<Approval>, questions: some Sequence<Question>, desktop: DesktopState?,
    computers: [ComputerInfo]
  ) -> Int {
    approvals.filter { $0.status == .pending }.count + questions.filter { $0.status == .pending }.count
      + (desktop?.request == nil ? 0 : 1) + computers.filter { $0.request != nil }.count
  }

  enum Item: Identifiable, Equatable {
    case approval(Approval)
    case question(Question)

    var id: String {
      switch self {
      case let .approval(a): "a\(a.id)"
      case let .question(q): "q\(q.id)"
      }
    }

    var createdAt: String {
      switch self {
      case let .approval(a): a.createdAt
      case let .question(q): q.createdAt
      }
    }

    private var asked: (conversationId: Int?, botId: String?) {
      switch self {
      case let .approval(a): (a.conversationId, a.botId)
      case let .question(q): (q.conversationId, q.botId)
      }
    }

    /// One asked in a chat waits there; one from a task, in the bot's chats but not its threads.
    func waits(in chat: Conversation) -> Bool {
      if let id = asked.conversationId { return id == chat.id }
      return chat.kind != .thread && asked.botId.map(chat.botIds.contains) == true
    }

    func home(in chats: [Conversation]) -> Conversation? {
      if let id = asked.conversationId { return chats.first { $0.id == id } }
      return chats.first { $0.kind == .direct && $0.botIds.first == asked.botId }
    }
  }

  struct Split: Equatable {
    var here: [Item] = []
    var rest = 0
    /// The one chat all the rest wait in, if they do.
    var elsewhere: Conversation?
  }

  static func split(_ items: [Item], in chat: Conversation?, chats: [Conversation]) -> Split {
    let here = chat.map { c in items.filter { $0.waits(in: c) } } ?? []
    let rest = items.filter { i in !here.contains { $0.id == i.id } }
    let homes = Set(rest.map { $0.home(in: chats)?.id })
    let only = homes.count == 1 ? homes.first! : nil
    return Split(here: here, rest: rest.count, elsewhere: only.flatMap { id in chats.first { $0.id == id } })
  }
}
