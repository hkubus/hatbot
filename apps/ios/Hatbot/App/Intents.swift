// Siri and Shortcuts (App Intents): ask Hatbot and hear its answer, give it a task, or send it text and
// files. They run in the app, as you, through Hatbot's own chat.
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

struct AskHatbotIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Hatbot"
  static let description = IntentDescription("Asks Hatbot in its chat and answers with its reply.")

  @Parameter(title: "Question", inputOptions: String.IntentInputOptions(multiline: true))
  var question: String

  static var parameterSummary: some ParameterSummary { Summary("Ask Hatbot \(\.$question)") }

  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let r: AskResult = try await signedIn().post(
      "/thread/ask", body: Post(text: question), timeout: API.askTimeout)
    return .result(value: r.answer, dialog: IntentDialog(stringLiteral: r.answer))
  }
}

struct StartTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Give Hatbot a Task"
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

struct SendToHatbotIntent: AppIntent {
  static let title: LocalizedStringResource = "Send to Hatbot"
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
      // Photos go up as JPEG, like from the composer.
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
      intent: SendToHatbotIntent(),
      phrases: ["Send to \(.applicationName)"],
      shortTitle: "Send to Hatbot", systemImageName: "paperplane")
  }
}
