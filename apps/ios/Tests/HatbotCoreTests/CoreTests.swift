import Foundation
import XCTest

// The core is its own module in Package.swift and part of the app in Xcode.
#if canImport(HatbotCore)
  @testable import HatbotCore
#else
  @testable import Hatbot
#endif

final class ModelTests: XCTestCase {
  private func event(_ json: String) throws -> HatbotEvent {
    try JSONDecoder().decode(HatbotEvent.self, from: Data(json.utf8))
  }

  func testDecodesEventsAndIgnoresUnknownOnes() throws {
    guard case let .messageDelta(id, text) = try event(#"{"type":"message.delta","id":4,"text":"Hi"}"#) else {
      return XCTFail("not a delta")
    }
    XCTAssertEqual(id, 4)
    XCTAssertEqual(text, "Hi")
    guard case .unknown("teach.updated") = try event(#"{"type":"teach.updated","session":{}}"#) else {
      return XCTFail("not unknown")
    }
  }

  func testUnknownEnumValuesFallBack() throws {
    let json = #"""
      {"id":1,"role":"assistant","kind":"poll","text":"x","status":"done","createdAt":"2026-10-10T08:00:00.000Z",
       "taskId":null,"approvalId":null,"scheduleId":null}
      """#
    let m = try JSONDecoder().decode(ThreadMessage.self, from: Data(json.utf8))
    XCTAssertEqual(m.kind, .text)
  }

  func testEncodesLiveInput() throws {
    let data = try JSONEncoder().encode(LiveInput.key("Enter", down: true))
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(obj["t"] as? String, "key")
    XCTAssertEqual(obj["key"] as? String, "Enter")
    XCTAssertEqual(obj["down"] as? Bool, true)
  }

  func testParsesBrainDates() {
    XCTAssertNotNil(Format.date("2026-10-10T08:00:00.123Z"))
    XCTAssertNotNil(Format.date("2026-10-10T08:00:00Z"))
  }

  func testNormalisesServerAddresses() {
    XCTAssertEqual(API.serverURL(from: "hatbot.example.com")?.absoluteString, "https://hatbot.example.com")
    XCTAssertEqual(API.serverURL(from: " https://h.example/api/v1/ ")?.absoluteString, "https://h.example")
    XCTAssertEqual(
      API.serverURL(from: "http://192.168.55.230:8080")?.absoluteString, "http://192.168.55.230:8080")
    XCTAssertNil(API.serverURL(from: ""))
  }
}

final class CronTests: XCTestCase {
  func testDescribesCron() {
    let cases = [
      ("0 8 * * *", "Every day at 08:00"),
      ("30 7 * * 1-5", "Weekdays at 07:30"),
      ("*/15 * * * *", "Every 15 minutes"),
      ("0 * * * *", "Every hour"),
      ("0 9 * * 1", "Every Monday at 09:00"),
      ("0 9 * * 1,3", "Mon and Wed at 09:00"),
      ("0 6 1 * *", "1st of the month at 06:00"),
      ("@daily", "Every day at 00:00"),
      ("0 8 * 1 *", "0 8 * 1 *"),
    ]
    for (expr, words) in cases { XCTAssertEqual(Format.describeCron(expr), words, expr) }
  }
}

final class MarkdownTests: XCTestCase {
  func testSplitsBlocks() {
    let md = """
      # Title
      Some **bold** text
      on two lines.

      - one
        - nested
      - two

      1. first
      2. second

      > quoted

      ```swift
      let x = 1
      ```

      | A | B |
      |---|:-:|
      | 1 | 2 |

      ---
      """
    XCTAssertEqual(
      Markdown.parse(md),
      [
        .heading(level: 1, text: "Title"),
        .paragraph("Some **bold** text\non two lines."),
        .list([
          .init(depth: 0, marker: "•", text: "one"),
          .init(depth: 1, marker: "•", text: "nested"),
          .init(depth: 0, marker: "•", text: "two"),
        ]),
        .list([.init(depth: 0, marker: "1.", text: "first"), .init(depth: 0, marker: "2.", text: "second")]),
        .quote("quoted"),
        .code(language: "swift", code: "let x = 1"),
        .table(header: ["A", "B"], rows: [["1", "2"]]),
        .rule,
      ])
  }

  func testChartBlocks() {
    let json = #"{"type":"bar","unit":"$","x":["Mon",2],"series":[{"data":[1.5,null]},{"name":"tasks","data":[0.8,2]}]}"#
    guard case let .chart(spec)? = Markdown.parse("```chart\n\(json)\n```").first else {
      return XCTFail("not a chart")
    }
    XCTAssertEqual(spec.type, .bar)
    XCTAssertEqual(spec.x, ["Mon", "2"])
    XCTAssertEqual(spec.series[0].data, [1.5, nil])
    XCTAssertEqual(spec.names, ["Series 1", "tasks"])
    // Still streaming: a placeholder, not raw JSON.
    XCTAssertEqual(Markdown.parse("```chart\n{\"type\":"), [.chartPending])
    // Finished but malformed (a series that doesn't line up): plain code.
    let bad = #"{"type":"line","x":["a","b"],"series":[{"data":[1]}]}"#
    XCTAssertEqual(Markdown.parse("```chart\n\(bad)\n```"), [.code(language: "chart", code: bad)])
  }

  func testStackedAndHorizontalBars() {
    let spec = ChartSpec.parse(
      #"{"type":"bar","stacked":true,"x":["a","b"],"series":[{"data":[2,-1]},{"data":[3,null]},{"data":[-4,5]}]}"#)!
    XCTAssertTrue(spec.isStacked)
    XCTAssertFalse(spec.horizontal)
    let spans = spec.stackSpans.map { $0.map { $0.map { [$0.start, $0.end] } } }
    XCTAssertEqual(spans, [[[0, 2], [2, 5], [0, -4]], [[0, -1], nil, [0, 5]]])
    XCTAssertEqual(spec.stackTotals, [1, 4])
    func rows(_ n: Int) -> String {
      let x = (0..<n).map { "\"h\($0)\"" }.joined(separator: ",")
      let d = Array(repeating: "1", count: n).joined(separator: ",")
      return #"{"type":"bar","horizontal":true,"x":["# + x + #"],"series":[{"data":["# + d + "]}]}"
    }
    XCTAssertNotNil(ChartSpec.parse(rows(40)))
    XCTAssertNil(ChartSpec.parse(rows(41)))
  }

  func testChartValues() {
    func spec(_ unit: String?) -> ChartSpec {
      ChartSpec.parse(#"{"type":"line","x":["a"],"series":[{"data":[1]}]}"#.replacingOccurrences(
        of: "\"line\"", with: unit.map { "\"line\",\"unit\":\"\($0)\"" } ?? "\"line\""))!
    }
    XCTAssertEqual(spec(nil).format(1284), "1,284")
    XCTAssertEqual(spec(nil).format(12900, compact: true), "12.9K")
    XCTAssertEqual(spec(nil).format(0.4213), "0.42")
    XCTAssertEqual(spec("%").format(42.25), "42.3%")
    XCTAssertEqual(spec("GiB").format(3.1), "3.1 GiB")
    XCTAssertEqual(spec("$").format(4_200_000, compact: true), "$4.2M")
    XCTAssertEqual(spec("$").format(0.8), "$0.80")
    XCTAssertEqual(spec("€").format(-12), "-€12")
  }

  func testUnclosedFenceRunsToTheEnd() {
    XCTAssertEqual(
      Markdown.parse("Look:\n```\nstill typing"), [.paragraph("Look:"), .code(language: nil, code: "still typing")])
  }
}

// Not a @MainActor class: Linux XCTest can't run those.
final class StoreTests: XCTestCase {
  @MainActor private static func store() -> AppStore {
    AppStore(api: API(server: URL(string: "https://h.example")!, token: nil))
  }

  func testAppliesStreamingEvents() async {
    await MainActor.run { Self.appliesStreamingEvents() }
  }

  func testCountsWhatNeedsYou() async {
    await MainActor.run { Self.countsWhatNeedsYou() }
  }

  @MainActor private static func appliesStreamingEvents() {
    let store = store()
    let m = ThreadMessage(
      id: 7, role: .assistant, kind: .text, text: "", status: .streaming, createdAt: "2026-10-10T08:00:00Z")
    store.apply(.messageCreated(m))
    store.apply(.messageDelta(id: 7, text: "Hel"))
    store.apply(.messageDelta(id: 7, text: "lo"))
    store.apply(.messageProgress(id: 7, text: "thinking"))
    XCTAssertEqual(store.messages.first?.text, "Hello")
    XCTAssertEqual(store.progress[7], "thinking")
    store.apply(.messageDone(id: 7, text: "Hello.", status: .done))
    XCTAssertEqual(store.messages.first?.text, "Hello.")
    XCTAssertEqual(store.messages.first?.status, .done)
    XCTAssertNil(store.progress[7])
  }

  @MainActor private static func countsWhatNeedsYou() {
    let store = store()
    let a = Approval(
      id: 1, taskId: 2, kind: "send", summary: "Send it", reason: "", sources: [], screenshotStepId: nil,
      status: .pending, decidedVia: nil, costUsd: 0, createdAt: "", expiresAt: "", decidedAt: nil)
    store.apply(.approvalCreated(a))
    store.apply(.desktopState(.init(online: true, control: .hatbot, request: .init(taskId: 2, reason: "Captcha"))))
    XCTAssertEqual(store.needsYou, 2)
    var done = a
    done.status = .approved
    store.apply(.approvalResolved(done))
    XCTAssertEqual(store.needsYou, 1)
  }
}

final class ScheduleAndMemoryTests: XCTestCase {
  func testDecodesTriggersAndTheirSecret() throws {
    let json = #"""
      {"type":"trigger.updated","trigger":{"id":3,"name":"Kuma","kind":"kuma","trusted":true,"prompt":"Fix it",
       "enabled":true,"url":"https://h.example/api/v1/hooks/kuma/3","createdAt":"2026-10-10T08:00:00.000Z",
       "lastFiredAt":null,"lastTaskId":null,"confirmChecks":1}}
      """#
    guard case let .triggerUpdated(t) = try JSONDecoder().decode(HatbotEvent.self, from: Data(json.utf8)) else {
      return XCTFail("not a trigger")
    }
    XCTAssertEqual(t.kind, .kuma)
    XCTAssertEqual(t.confirmChecks, 1)
    let withSecret = #"""
      {"id":3,"name":"Kuma","kind":"kuma","trusted":true,"prompt":"Fix it","enabled":true,
       "url":"https://h.example/api/v1/hooks/kuma/3","createdAt":"2026-10-10T08:00:00.000Z","lastFiredAt":null,
       "lastTaskId":null,"secret":"s3cret"}
      """#
    let ws = try JSONDecoder().decode(TriggerWithSecret.self, from: Data(withSecret.utf8))
    XCTAssertEqual(ws.postURL, "https://h.example/api/v1/hooks/kuma/3?token=s3cret")
  }

  func testOlderBrainsWithoutNewFieldsStillDecode() throws {
    let settings = #"""
      {"limits":{"taskUsd":3,"dailyUsd":10,"monthlyUsd":200},"chatEffort":"low",
       "owner":{"name":"You","email":"o@l"},"paused":false}
      """#
    let s = try JSONDecoder().decode(AppSettings.self, from: Data(settings.utf8))
    XCTAssertNil(s.notificationsOpen)
    let schedule = #"""
      {"id":1,"name":"News","cron":"0 8 * * *","runAt":null,"prompt":"x","enabled":true,"createdVia":"chat",
       "createdAt":"2026-10-10T08:00:00.000Z","nextRunAt":null,"lastRunAt":null,"lastTaskId":null}
      """#
    XCTAssertNil(try JSONDecoder().decode(Schedule.self, from: Data(schedule.utf8)).tainted)
  }

  func testReadsAppLinks() {
    let link = { (s: String) in AppLink(url: URL(string: s)!) }
    XCTAssertEqual(link("hatbot://tasks/12"), .task(12))
    XCTAssertEqual(link("hatbot://approvals/5"), .approval(5))
    XCTAssertEqual(link("hatbot://schedules/2"), .schedule(2))
    XCTAssertEqual(link("hatbot://triggers/3"), .trigger(3))
    XCTAssertNil(link("hatbot://memory/1"))
    XCTAssertNil(link("hatbot://tasks/1/2"))
    XCTAssertNil(link("https://tasks/1"))
  }

  func testGroupsMemoryFilesByFolder() {
    let files = ["skills/b.md", "INDEX.md", "projects/x.md", "about-you.md", "skills/a.md"]
      .map { MemoryFile(path: $0, size: 1) }
    let groups = MemoryTree.groups(files)
    XCTAssertEqual(groups.map(\.folder), ["", "projects", "skills"])
    XCTAssertEqual(groups[0].files.map(\.path), ["INDEX.md", "about-you.md"])
    XCTAssertEqual(groups[2].files.map(\.path), ["skills/a.md", "skills/b.md"])
    XCTAssertEqual(MemoryTree.name("skills/a.md"), "a.md")
    XCTAssertEqual(MemoryTree.newPath(" /projects/garden "), "projects/garden.md")
    XCTAssertNil(MemoryTree.newPath("../etc/passwd"))
    XCTAssertNil(MemoryTree.newPath("  "))
  }

  func testParsesDiffs() {
    let diff = """
      diff --git a/INDEX.md b/INDEX.md
      index 1..2 100644
      --- a/INDEX.md
      +++ b/INDEX.md
      @@ -1,2 +1,2 @@
       # Memory index
      -old
      +new
      """
    XCTAssertEqual(
      DiffLine.parse(diff).map(\.kind), [.hunk, .context, .removed, .added])
  }

  func testEscapesQueryValues() {
    XCTAssertEqual(API.query("notes/a b&c+d.md"), "notes/a%20b%26c%2Bd.md")
  }
}

final class FoldTests: XCTestCase {
  private func m(_ id: Int, _ episode: Int?, _ role: ThreadMessage.Role = .assistant) -> ThreadMessage {
    ThreadMessage(
      id: id, role: role, kind: .text, text: "message \(id)", status: .done, createdAt: "", episodeId: episode)
  }

  func testFoldsFinishedConversations() {
    let groups = ThreadFolds.groups(
      [m(1, nil), m(2, 1, .user), m(3, 1), m(4, nil), m(5, 2, .user), m(6, 3, .user), m(7, 3)],
      episodes: [1: Episode(id: 1, startedAt: "", lastActivityAt: "", recap: "Talked about one.")])
    XCTAssertEqual(groups.map(\.episodeId), [nil, 1, 2, 3])
    XCTAssertEqual(groups.map { $0.messages.map(\.id) }, [[1], [2, 3, 4], [5], [6, 7]])
    XCTAssertEqual(groups.map(\.fold), [nil, "Talked about one.", "message 5", nil])
  }

  func testCommandsFoldWithoutNamingTheConversation() {
    var command = m(2, 1, .user)
    command.kind = .command
    command.text = "/remember x"
    let groups = ThreadFolds.groups([command, m(3, 1, .user), m(4, 2, .user)], episodes: [:])
    XCTAssertEqual(groups.map(\.fold), ["message 3", nil])
  }

  func testMatchesCommandsWhileYouTypeTheName() {
    XCTAssertEqual(ChatCommand.matching("/").map(\.name), ["new", "stop", "task", "remember"])
    XCTAssertEqual(ChatCommand.matching("/RE").map(\.name), ["remember"])
    XCTAssertEqual(ChatCommand.matching("/task x"), [])
    XCTAssertEqual(ChatCommand.matching("/etc/"), [])
    XCTAssertEqual(ChatCommand.matching("hi"), [])
    XCTAssertEqual(ChatCommand.matching("/", incognito: true).map(\.name), ["new", "stop"])
    XCTAssertTrue(ChatCommand.all[2].needsMore)
    XCTAssertFalse(ChatCommand.all[1].needsMore)
    var note = m(5, 1)
    note.kind = .command
    XCTAssertTrue(note.isNote)
    note.taskId = 3
    XCTAssertFalse(note.isNote)
  }

  func testTimelineKeepsOnlyTheLatestModelNote() {
    func step(_ id: Int, _ kind: TaskStep.Kind, _ name: String = "Note") -> TaskStep {
      TaskStep(id: id, taskId: 1, kind: kind, name: name, detail: "", createdAt: "")
    }
    let steps = [step(1, .note), step(2, .action), step(3, .note, "Your note"), step(4, .note)]
    XCTAssertEqual(steps.latestNoteOnly.map(\.id), [2, 3, 4])
  }

  func testDecodesBotsAndConversations() throws {
    let bot = #"""
      {"type":"bot.updated","bot":{"id":"chef","name":"Chef","instructions":"Plans meals.","chatModel":null,
       "chatEffort":"medium","plugins":["mail"],"createdAt":"2026-10-14T08:00:00.000Z"}}
      """#
    guard case let .botUpdated(b) = try JSONDecoder().decode(HatbotEvent.self, from: Data(bot.utf8)) else {
      return XCTFail("not a bot")
    }
    XCTAssertEqual(b.id, "chef")
    XCTAssertNil(b.chatModel)
    XCTAssertEqual(b.chatEffort, .medium)
    XCTAssertEqual(b.plugins, ["mail"])
    let chat = #"""
      {"type":"conversation.updated","conversation":{"id":2,"kind":"party","title":null,"botIds":["chef"],
       "unread":3,"lastMessageAt":null}}
      """#
    guard case let .conversationUpdated(c) = try JSONDecoder().decode(HatbotEvent.self, from: Data(chat.utf8)) else {
      return XCTFail("not a conversation")
    }
    XCTAssertEqual(c.kind, .direct)
    XCTAssertEqual(c.unread, 3)
    guard case .conversationDeleted(id: 2) = try JSONDecoder().decode(
      HatbotEvent.self, from: Data(#"{"type":"conversation.deleted","id":2}"#.utf8))
    else { return XCTFail("not deleted") }
  }

  func testCompletesMentions() {
    XCTAssertEqual(Mention.partial("hi @ch"), "ch")
    XCTAssertEqual(Mention.partial("@"), "")
    XCTAssertNil(Mention.partial("me@ch"))
    XCTAssertNil(Mention.partial("@chef done"))
    XCTAssertEqual(Mention.complete("ask @ho", with: "Home Lab"), "ask @Home Lab ")
    let bots = [
      Bot(id: "chef", name: "Chef", instructions: "", createdAt: ""),
      Bot(id: "home-lab", name: "Home Lab", instructions: "", createdAt: ""),
    ]
    XCTAssertEqual(Mention.matching("H", in: bots).map(\.id), ["home-lab"])
    XCTAssertEqual(Mention.matching("", in: bots).count, 2)
  }

  func testDecodesABotsIconAndColour() throws {
    let json = #"{"id":"chef","name":"Chef","icon":"cat","color":"teal","instructions":"","createdAt":""}"#
    let bot = try JSONDecoder().decode(Bot.self, from: Data(json.utf8))
    XCTAssertEqual(bot.icon, .cat)
    XCTAssertEqual(bot.color, .teal)
    let newer = json.replacingOccurrences(of: "\"cat\"", with: "\"rocket\"")
    XCTAssertEqual(try JSONDecoder().decode(Bot.self, from: Data(newer.utf8)).icon, .hat)
    XCTAssertEqual(Bot.Icon.code.symbol, "chevron.left.forwardslash.chevron.right")
  }

  func testEncodesABotChangeWithNulls() throws {
    let change = AppStore.BotChange(name: nil, instructions: "x", chatModel: nil, chatEffort: .low, plugins: nil)
    let json = String(decoding: try JSONEncoder().encode(change), as: UTF8.self)
    XCTAssertFalse(json.contains("\"name\""))
    XCTAssertTrue(json.contains("\"chatModel\":null"))
    XCTAssertTrue(json.contains("\"plugins\":null"))
    XCTAssertTrue(json.contains("\"chatEffort\":\"low\""))
    XCTAssertFalse(json.contains("\"icon\""))
  }

  func testDecodesEpisodeEvents() throws {
    let json = #"{"type":"episode.updated","episode":{"id":4,"startedAt":"a","lastActivityAt":"b","recap":"R"}}"#
    guard case let .episodeUpdated(e) = try JSONDecoder().decode(HatbotEvent.self, from: Data(json.utf8)) else {
      return XCTFail("not an episode")
    }
    XCTAssertEqual(e.recap, "R")
  }
}

final class UsageTests: XCTestCase {
  func testDecodesReplyUsageAndFormatsTokens() throws {
    let json = #"{"type":"message.usage","id":9,"tokens":4200,"costUsd":0.021}"#
    guard case let .messageUsage(id, used) = try JSONDecoder().decode(HatbotEvent.self, from: Data(json.utf8)) else {
      return XCTFail("not usage")
    }
    XCTAssertEqual(id, 9)
    XCTAssertEqual(used, ReplyUsage(tokens: 4200, costUsd: 0.021))
    XCTAssertEqual([950, 4200, 3_100_000].map(Format.tokens), ["950", "4.2k", "3.1M"])
  }
}

// Not a @MainActor method: Linux XCTest can't run those.
final class UnreadTests: XCTestCase {
  func testEditedAndSeenEventsTrackUnread() async throws {
    try await MainActor.run { try Self.editedAndSeenEventsTrackUnread() }
  }

  @MainActor private static func editedAndSeenEventsTrackUnread() throws {
    let decode = { (json: String) in try JSONDecoder().decode(HatbotEvent.self, from: Data(json.utf8)) }
    let store = AppStore(api: API(server: URL(string: "https://h.example")!, token: nil))
    store.apply(try decode(
      #"{"type":"message.created","message":{"id":3,"role":"assistant","kind":"text","text":"On it.","status":"done","createdAt":"2026-10-11T10:00:00.000Z","taskId":7,"approvalId":null,"scheduleId":null,"episodeId":1,"editedAt":null,"seenAt":null}}"#))
    XCTAssertEqual(store.unread, [3])
    store.apply(try decode(#"{"type":"message.seen","ids":[3],"seenAt":"2026-10-11T10:00:01.000Z"}"#))
    XCTAssertEqual(store.unread, [])
    store.apply(try decode(#"{"type":"message.edited","id":3,"editedAt":"2026-10-11T10:05:00.000Z"}"#))
    XCTAssertEqual(store.unread, [3])
    XCTAssertEqual(store.messages.first?.editedAt, "2026-10-11T10:05:00.000Z")
    // Its task ended: its bot writes it again.
    store.apply(try decode(#"{"type":"message.rewrite","id":3}"#))
    XCTAssertEqual(store.messages.first?.text, "")
    XCTAssertEqual(store.messages.first?.status, .streaming)
  }
}

// Not a @MainActor method: Linux XCTest can't run those.
final class AttachmentTests: XCTestCase {
  func testAttachmentEventsAddFilesOnce() async throws {
    try await MainActor.run { try Self.attachmentEventsAddFilesOnce() }
  }

  @MainActor private static func attachmentEventsAddFilesOnce() throws {
    let store = AppStore(api: API(server: URL(string: "https://h.example")!, token: nil))
    let created = #"{"type":"message.created","message":{"id":5,"role":"assistant","kind":"text","text":"Here","status":"done","createdAt":"t"}}"#
    store.apply(try JSONDecoder().decode(HatbotEvent.self, from: Data(created.utf8)))
    XCTAssertNil(store.messages.first?.attachments)
    let json = #"{"type":"message.attachment","id":5,"attachment":{"id":3,"name":"chart.png","mediaType":"image/png","size":2048,"from":"hatbot","createdAt":"t"}}"#
    let event = try JSONDecoder().decode(HatbotEvent.self, from: Data(json.utf8))
    store.apply(event)
    store.apply(event)
    XCTAssertEqual(store.messages.first?.attachments?.map(\.id), [3])
    XCTAssertEqual(store.messages.first?.attachments?.first?.isPicture, true)
  }
}

// Not a @MainActor method: Linux XCTest can't run those.
final class IncognitoTests: XCTestCase {
  func testIncognitoMessagesStayOutOfTheThreadAndAreNeverUnread() async throws {
    try await MainActor.run { try Self.incognitoMessagesStayOut() }
  }

  @MainActor private static func incognitoMessagesStayOut() throws {
    let decode = { (json: String) in try JSONDecoder().decode(HatbotEvent.self, from: Data(json.utf8)) }
    let store = AppStore(api: API(server: URL(string: "https://h.example")!, token: nil))
    store.apply(try decode(
      #"{"type":"message.created","message":{"id":4,"role":"assistant","kind":"text","text":"Psst.","status":"done","createdAt":"t","incognito":true}}"#))
    store.apply(try decode(#"{"type":"message.done","id":4,"text":"Psst.","status":"done"}"#))
    store.apply(try decode(
      #"{"type":"message.created","message":{"id":5,"role":"assistant","kind":"text","text":"Hi.","status":"done","createdAt":"t"}}"#))
    XCTAssertEqual(store.messages.map(\.id), [5])
    XCTAssertEqual(store.unread, [5])
    store.apply(try decode(#"{"type":"message.deleted","ids":[5]}"#))
    XCTAssertEqual(store.messages, [])
    XCTAssertEqual(store.unread, [])
  }
}
