// Intents run only on an unlocked phone: whoever holds a locked one isn't necessarily you.
import AppIntents
import Foundation
import UniformTypeIdentifiers

private func signedIn() throws -> API {
  guard let api = AppGroup.api() else {
    throw APIError(status: 0, message: "Sign in to Hatbot in the app first.")
  }
  return api
}

private struct Post: Encodable {
  let text: String
  var attachmentIds: [Int] = []
}

struct ChatEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Chat"
  static let defaultQuery = ChatQuery()

  let id: Int
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ChatQuery: EntityQuery {
  func entities(for identifiers: [Int]) async throws -> [ChatEntity] {
    try await Self.all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [ChatEntity] {
    try await Self.all()
  }

  /// A brain from before bots has none.
  static func all() async throws -> [ChatEntity] {
    let api = try signedIn()
    let bots: [Bot] = try await api.get("/bots")
    let chats: [Conversation] = try await api.get("/conversations")
    let names = Dictionary(bots.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    return chats.map { c in
      let name =
        c.kind == .group
        ? c.title ?? c.botIds.compactMap { names[$0] }.joined(separator: ", ")
        : names[c.botIds.first ?? ""] ?? "Hatbot"
      return ChatEntity(id: c.id, name: name)
    }
  }
}

struct AskHatbotIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Hatbot"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let description = IntentDescription(
    "Asks Hatbot, or another bot or a group, in its chat and answers with the reply.")

  @Parameter(title: "Question", inputOptions: String.IntentInputOptions(multiline: true))
  var question: String

  /// None: Hatbot's own chat.
  @Parameter(title: "Chat")
  var chat: ChatEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("Ask \(\.$chat) \(\.$question)")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let path = chat.map { "/conversations/\($0.id)/ask" } ?? "/thread/ask"
    let r: AskResult = try await signedIn().post(path, body: Post(text: question), timeout: API.askTimeout)
    return .result(value: r.answer, dialog: IntentDialog(stringLiteral: r.answer))
  }
}

struct StartTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Give Hatbot a Task"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let description = IntentDescription("Starts a background task with this goal; it tells you when it's done.")

  @Parameter(title: "Goal", inputOptions: String.IntentInputOptions(multiline: true))
  var goal: String

  static var parameterSummary: some ParameterSummary { Summary("Give Hatbot the task \(\.$goal)") }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let text = goal.trimmingCharacters(in: .whitespacesAndNewlines)
    let _: ThreadMessage = try await signedIn().post("/thread/messages", body: Post(text: "/task \(text)"))
    return .result(dialog: "Hatbot is on it.")
  }
}

struct AddTodoIntent: AppIntent {
  static let title: LocalizedStringResource = "Add a To-do"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let description = IntentDescription("Adds an item to the to-do list Hatbot keeps and reminds you of.")

  @Parameter(title: "Item")
  var item: String

  @Parameter(title: "Due")
  var due: Date?

  static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$item) to the to-do list") { \.$due }
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    struct Body: Encodable { let item: String; let due: String? }
    let text = item.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw APIError(status: 0, message: "There's nothing to add.") }
    // The day only: a time Siri fills in for "tomorrow" would be a reminder at that time.
    let day = due.map { d in
      let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
      return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
    let _: TodoList = try await signedIn().post("/todo", body: Body(item: text, due: day))
    return .result(dialog: "Added to your to-do list.")
  }
}

struct SendToHatbotIntent: AppIntent {
  static let title: LocalizedStringResource = "Send to Hatbot"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  static let description = IntentDescription("Sends text and files to Hatbot's chat, like writing it yourself.")

  @Parameter(title: "Text", inputOptions: String.IntentInputOptions(multiline: true))
  var text: String?

  @Parameter(title: "Files", supportedContentTypes: [.item])
  var files: [IntentFile]?

  static var parameterSummary: some ParameterSummary { Summary("Send \(\.$text) and \(\.$files) to Hatbot") }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let api = try signedIn()
    var ids: [Int] = []
    for (i, f) in (files ?? []).prefix(10).enumerated() {
      var data = f.data
      var name = f.filename
      var mediaType = f.type?.preferredMIMEType ?? "application/octet-stream"
      if f.type?.conforms(to: .image) == true, let photo = PickedFile.photo(f.data, index: i + 1) {
        (data, name, mediaType) = (photo.data, photo.name, "image/jpeg")
      }
      let a: Attachment = try await api.upload("/attachments", data: data, name: name, mediaType: mediaType)
      ids.append(a.id)
    }
    let body = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty || !ids.isEmpty else { throw APIError(status: 0, message: "There's nothing to send.") }
    let _: ThreadMessage = try await api.post("/thread/messages", body: Post(text: body, attachmentIds: ids))
    return .result(dialog: "Sent.")
  }
}

struct HatbotShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskHatbotIntent(),
      phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) something"],
      shortTitle: "Ask Hatbot", systemImageName: "bubble.left")
    AppShortcut(
      intent: StartTaskIntent(),
      phrases: ["Give \(.applicationName) a task", "Start a \(.applicationName) task"],
      shortTitle: "Give Hatbot a Task", systemImageName: "checklist")
    AppShortcut(
      intent: AddTodoIntent(),
      phrases: ["Add a to-do in \(.applicationName)", "Add to my \(.applicationName) to-do list"],
      shortTitle: "Add a To-do", systemImageName: "checkmark.square")
    AppShortcut(
      intent: SendToHatbotIntent(),
      phrases: ["Send to \(.applicationName)"],
      shortTitle: "Send to Hatbot", systemImageName: "paperplane")
  }
}
