import Foundation

extension AppStore {
  @discardableResult
  func loadBoxes() async throws -> [Box] {
    let list: [Box] = try await api.get("/boxes")
    // One we had that isn't listed was deleted while we were away.
    for id in boxes.keys where !list.contains(where: { $0.id == id }) { deletedBoxes.insert(id) }
    boxes = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
    boxesLoaded = true
    return list
  }

  func loadBox(_ id: Int) async throws -> BoxDetail {
    do {
      return keep(try await api.get("/boxes/\(id)"))
    } catch let error as APIError where error.status == 404 {
      boxes[id] = nil
      deletedBoxes.insert(id)
      throw error
    }
  }

  private func keep(_ d: BoxDetail) -> BoxDetail {
    boxes[d.box.id] = d.box
    return d
  }

  func boxPage(_ id: Int, version: Int) async throws -> BoxPage {
    try await api.get("/boxes/\(id)/versions/\(version)")
  }

  func revertBox(_ id: Int, to version: Int) async throws -> BoxDetail {
    struct Body: Encodable { let version: Int }
    return keep(try await api.post("/boxes/\(id)/revert", body: Body(version: version)))
  }

  func deleteBox(_ id: Int) async throws {
    let _: Empty = try await api.delete("/boxes/\(id)")
    boxes[id] = nil
    deletedBoxes.insert(id)
  }

  /// Where to open a version's page, signed for 10 minutes in place of the token, under the brain's
  /// address. Asked for each time a box opens, and on Reload.
  func boxAddress(_ id: Int, version: Int, dark: Bool) async throws -> URL {
    struct Body: Encodable {
      let version: Int
      let dark: Bool
    }
    struct Opened: Decodable { let url: String }
    let opened: Opened = try await api.post("/boxes/\(id)/open", body: Body(version: version, dark: dark))
    guard opened.url.hasPrefix("/"), let url = URL(string: api.server.absoluteString + opened.url) else {
      throw APIError(status: 0, message: "Hatbot sent something this app doesn't understand.")
    }
    return url
  }

  /// A call from a box's page, as `BoxBridge.json` gives it, passed on for the brain to check; the
  /// answer as it came.
  func callBox(_ id: Int, json: Data) async throws -> Data {
    try await api.post("/boxes/\(id)/call", json: json)
  }
}

enum BoxBridge {
  /// A call from the page as JSON, as the web app's JSON.stringify would send it: dates as ISO strings,
  /// NaN and infinities as null. Nil for anything but an object, which JSONSerialization would crash on.
  static func json(_ body: Any) -> Data? {
    guard body is [String: Any] else { return nil }
    let safe = jsonSafe(body)
    guard JSONSerialization.isValidJSONObject(safe) else { return nil }
    return try? JSONSerialization.data(withJSONObject: safe)
  }

  /// Only what JSON can't hold is changed: a JavaScript boolean comes as an NSNumber, which must go on
  /// as it is to stay a boolean.
  private static func jsonSafe(_ value: Any) -> Any {
    switch value {
    case let d as [String: Any]: d.mapValues(jsonSafe)
    case let a as [Any]: a.map(jsonSafe)
    case let date as Date: iso(date)
    case let n as Double where !n.isFinite: NSNull()
    default: value
    }
  }

  /// As JavaScript's toISOString writes it.
  private static func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
  }

  /// The answer's `value`, for WebKit to hand the page; nil when there's none, which the page gets as
  /// undefined.
  static func value(_ answer: Data) -> Any? {
    let object = try? JSONSerialization.jsonObject(with: answer, options: .fragmentsAllowed) as? [String: Any]
    return object?["value"]
  }
}

/// Where a box's web view may go. Its main frame stays on the box's page: links to web pages open
/// outside the app, and anything else that would take it away is refused, and the box shows Reload.
enum BoxNavigation: Equatable, Sendable {
  case allow
  /// A web page the box links to, opened outside the app.
  case open(URL)
  /// Refused; the page stays.
  case refuse
  /// Refused: the page tried to leave, or to load itself again.
  case leave

  /// `mainFrame`: nil for a new window. `link`: a link you followed. `address`: the box's page.
  /// `loaded`: that page is showing, after which it moves only within itself.
  static func decide(_ url: URL, mainFrame: Bool?, link: Bool, address: URL, loaded: Bool) -> Self {
    let web = ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    guard let mainFrame else { return web && !samePage(url, address) ? .open(url) : .refuse }
    // Frames inside the page reach nothing either way: its CSP has no frame-src.
    guard mainFrame else { return url.scheme?.lowercased() == "about" ? .allow : .refuse }
    if samePage(url, address) { return !loaded || url.fragment != nil ? .allow : .leave }
    return link && web ? .open(url) : .leave
  }

  /// The same page, whatever its fragment.
  static func samePage(_ a: URL?, _ b: URL) -> Bool {
    guard let a else { return false }
    return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host()?.lowercased() == b.host()?.lowercased()
      && a.port == b.port && a.path(percentEncoded: true) == b.path(percentEncoded: true)
      && a.query(percentEncoded: true) == b.query(percentEncoded: true)
  }
}
