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
    guard case .unknown("trigger.updated") = try event(#"{"type":"trigger.updated","trigger":{}}"#) else {
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
