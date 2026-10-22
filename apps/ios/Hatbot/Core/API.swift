import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

struct APIError: LocalizedError, Sendable {
  let status: Int
  let message: String
  /// The answer's body, for errors that say more than a message (a memory conflict's newer copy).
  var body = Data()
  var errorDescription: String? { message }
}

struct Empty: Codable, Sendable {}

struct Multipart: Sendable {
  let boundary: String
  let head: Data
  let tail: Data

  init(name: String, mediaType: String) {
    let boundary = "hatbot-\(UUID().uuidString)"
    let safe = name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_")
      .replacingOccurrences(of: "\n", with: "_")
    self.boundary = boundary
    head = Data(
      ("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safe)\"\r\n"
        + "Content-Type: \(mediaType)\r\n\r\n").utf8)
    tail = Data("\r\n--\(boundary)--\r\n".utf8)
  }

  func write(_ file: URL) throws -> URL {
    let out = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
    guard FileManager.default.createFile(atPath: out.path, contents: head) else { throw CocoaError(.fileWriteUnknown) }
    do {
      let writer = try FileHandle(forWritingTo: out)
      defer { try? writer.close() }
      try writer.seekToEnd()
      let reader = try FileHandle(forReadingFrom: file)
      defer { try? reader.close() }
      while let chunk = try reader.read(upToCount: 1 << 20), !chunk.isEmpty {
        try writer.write(contentsOf: chunk)
      }
      try writer.write(contentsOf: tail)
      return out
    } catch {
      try? FileManager.default.removeItem(at: out)
      throw error
    }
  }
}

final class API: Sendable {
  static let prefix = "/api/v1"

  let server: URL
  let token: String?
  private let session: URLSession
  private let onUnauthorized: @Sendable () -> Void

  init(
    server: URL,
    token: String?,
    session: URLSession = .shared,
    onUnauthorized: @escaping @Sendable () -> Void = {}
  ) {
    self.server = server
    self.token = token
    self.session = session
    self.onUnauthorized = onUnauthorized
  }

  /// The brain no longer takes the token, as told some other way than a JSON call (the event stream's handshake).
  func unauthorized() {
    onUnauthorized()
  }

  /// Never plain http: the token goes with every request, and a phone joins networks you don't control.
  static func serverURL(from input: String) -> URL? {
    var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if !s.contains("://") { s = "https://" + s }
    while s.hasSuffix("/") { s.removeLast() }
    if s.hasSuffix(prefix) { s.removeLast(prefix.count) }
    guard let url = URL(string: s), url.scheme?.lowercased() == "https", url.host != nil,
      var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    // "HTTPS://" would be saved as typed, and nothing after should have to compare cases.
    parts.scheme = "https"
    return parts.url
  }

  static func isPlainHTTP(_ input: String) -> Bool {
    input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("http://")
  }

  func url(_ path: String) -> URL {
    URL(string: server.absoluteString + Self.prefix + path)!
  }

  func get<T: Decodable>(_ path: String) async throws -> T {
    try await call(path, method: "GET", body: nil as Empty?)
  }

  @discardableResult
  func post<T: Decodable, B: Encodable>(_ path: String, body: B, timeout: TimeInterval? = nil) async throws -> T {
    try await call(path, method: "POST", body: body, timeout: timeout)
  }

  func post(_ path: String) async throws {
    let _: Empty = try await call(path, method: "POST", body: Empty())
  }

  /// A box's calls, which only the brain reads: JSON as it is, and the answer as it came.
  func post(_ path: String, json: Data) async throws -> Data {
    var req = request(path, method: "POST")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = json
    let (data, response) = try await load(req)
    try check(response, data: data, path: path)
    return data
  }

  func put<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
    try await call(path, method: "PUT", body: body)
  }

  func patch<T: Decodable, B: Encodable>(_ path: String, body: B, timeout: TimeInterval? = nil) async throws -> T {
    try await call(path, method: "PATCH", body: body, timeout: timeout)
  }

  @discardableResult
  func delete<T: Decodable>(_ path: String) async throws -> T {
    try await call(path, method: "DELETE", body: nil as Empty?)
  }

  /// A query value, escaped: memory paths can hold spaces, "&" or "+".
  static func query(_ value: String) -> String {
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&+=?#")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
  }

  func data(_ path: String) async throws -> Data {
    let (data, response) = try await session.data(for: request(path, method: "GET"))
    try check(response, data: data, path: path)
    return data
  }

  /// The most an attachment may be (MAX_ATTACHMENT_BYTES in apps/brain/src/attachments.ts).
  static let maxUpload = 25 * 1024 * 1024

  func upload<T: Decodable>(_ path: String, data: Data, name: String, mediaType: String) async throws -> T {
    let form = Multipart(name: name, mediaType: mediaType)
    var body = form.head
    body.append(data)
    body.append(form.tail)
    let req = uploadRequest(path, form)
    return try await send(path) { try await self.session.upload(for: req, from: body) }
  }

  /// Sent from disk in pieces: the share extension can't hold a big file in memory.
  func upload<T: Decodable>(_ path: String, file: URL, name: String, mediaType: String) async throws -> T {
    let form = Multipart(name: name, mediaType: mediaType)
    let body = try form.write(file)
    defer { try? FileManager.default.removeItem(at: body) }
    let req = uploadRequest(path, form)
    return try await send(path) {
      try await withCheckedThrowingContinuation { c in
        self.session.uploadTask(with: req, fromFile: body) { data, response, error in
          guard let response else { return c.resume(throwing: error ?? URLError(.badServerResponse)) }
          c.resume(returning: (data ?? Data(), response))
        }.resume()
      }
    }
  }

  private func uploadRequest(_ path: String, _ form: Multipart) -> URLRequest {
    var req = request(path, method: "POST")
    req.timeoutInterval = 120
    req.setValue("multipart/form-data; boundary=\(form.boundary)", forHTTPHeaderField: "Content-Type")
    return req
  }

  private func send<T: Decodable>(_ path: String, _ transfer: () async throws -> (Data, URLResponse)) async throws -> T {
    let (out, response): (Data, URLResponse)
    do {
      (out, response) = try await transfer()
    } catch {
      throw APIError(status: 0, message: "Couldn't reach Hatbot.")
    }
    try check(response, data: out, path: path)
    do {
      return try JSONDecoder().decode(T.self, from: out)
    } catch {
      throw APIError(status: 0, message: "Hatbot sent something this app doesn't understand.")
    }
  }

  /// Always wss: the token never goes unencrypted, whatever the server's address looks like.
  func webSocket(_ path: String) -> URLSessionWebSocketTask {
    var req = request(path, method: "GET")
    var parts = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
    parts.scheme = "wss"
    req.url = parts.url
    return session.webSocketTask(with: req)
  }

  /// Siri's ask: the brain waits up to 25 seconds for the reply.
  static let askTimeout: TimeInterval = 40
  /// Check everything tries each part, some of them slowly.
  static let checksTimeout: TimeInterval = 120
  /// A watcher that runs a page's scripts may wait behind others on the desktop, up to 2 minutes.
  static let watcherTimeout: TimeInterval = 130

  private func request(_ path: String, method: String) -> URLRequest {
    var req = URLRequest(url: url(path))
    req.httpMethod = method
    req.timeoutInterval = 30
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    return req
  }

  private func call<T: Decodable, B: Encodable>(
    _ path: String, method: String, body: B?, timeout: TimeInterval? = nil
  ) async throws -> T {
    var req = request(path, method: method)
    if let timeout { req.timeoutInterval = timeout }
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONEncoder().encode(body)
    }
    let (data, response) = try await load(req)
    try check(response, data: data, path: path)
    do {
      return try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("{}".utf8) : data)
    } catch {
      // 204 No Content, where an optional is expected: nothing.
      if data.isEmpty, let none = try? JSONDecoder().decode(T.self, from: Data("null".utf8)) { return none }
      throw APIError(status: 0, message: "Hatbot sent something this app doesn't understand.")
    }
  }

  private func load(_ req: URLRequest) async throws -> (Data, URLResponse) {
    do {
      return try await session.data(for: req)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as URLError where error.code == .cancelled {
      throw CancellationError()
    } catch {
      throw APIError(status: 0, message: "Couldn't reach Hatbot.")
    }
  }

  private func check(_ response: URLResponse, data: Data, path: String) throws {
    guard let http = response as? HTTPURLResponse else { return }
    guard !(200..<300).contains(http.statusCode) else { return }
    if http.statusCode == 401 && !path.hasPrefix("/auth/") { onUnauthorized() }
    let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
    throw APIError(status: http.statusCode, message: message ?? "HTTP \(http.statusCode)", body: data)
  }
}
