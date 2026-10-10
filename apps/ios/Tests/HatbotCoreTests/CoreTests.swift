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
