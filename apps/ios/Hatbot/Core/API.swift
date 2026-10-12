// JSON requests to the brain with the app's bearer token (PLAN.md §8).
import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

struct APIError: LocalizedError, Sendable {
  let status: Int
  let message: String
  var errorDescription: String? { message }
}

/// An empty or ignored response body.
struct Empty: Codable, Sendable {}

final class API: Sendable {
  static let prefix = "/api/v1"

  /// The server's root, like https://hatbot.example.com.
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

  /// "https://host/" or "host" → https://host; a pasted ".../api/v1" is dropped. Plain http only when typed.
  static func serverURL(from input: String) -> URL? {
    var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if !s.contains("://") { s = "https://" + s }
    while s.hasSuffix("/") { s.removeLast() }
    if s.hasSuffix(prefix) { s.removeLast(prefix.count) }
    guard let url = URL(string: s), let scheme = url.scheme, ["http", "https"].contains(scheme),
      url.host != nil
    else { return nil }
    return url
  }

  func url(_ path: String) -> URL {
    URL(string: server.absoluteString + Self.prefix + path)!
  }

  func get<T: Decodable>(_ path: String) async throws -> T {
    try await call(path, method: "GET", body: nil as Empty?)
  }

  @discardableResult
  func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
    try await call(path, method: "POST", body: body)
  }

  func post(_ path: String) async throws {
    let _: Empty = try await call(path, method: "POST", body: Empty())
  }

  func put<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
    try await call(path, method: "PUT", body: body)
  }

  func patch<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
    try await call(path, method: "PATCH", body: body)
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

  /// Raw bytes, for screenshots.
  func data(_ path: String) async throws -> Data {
    let (data, response) = try await session.data(for: request(path, method: "GET"))
    try check(response, data: data, path: path)
    return data
  }

  /// A file as multipart field "file"; the answer is JSON.
  func upload<T: Decodable>(_ path: String, data: Data, name: String, mediaType: String) async throws -> T {
    var req = request(path, method: "POST")
    req.timeoutInterval = 120
    let boundary = "hatbot-\(UUID().uuidString)"
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    let safe = name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_")
      .replacingOccurrences(of: "\n", with: "_")
    var body = Data()
    body.append(Data("--\(boundary)\r\n".utf8))
    body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(safe)\"\r\n".utf8))
    body.append(Data("Content-Type: \(mediaType)\r\n\r\n".utf8))
    body.append(data)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    let (out, response): (Data, URLResponse)
    do {
      (out, response) = try await session.upload(for: req, from: body)
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

  /// A WebSocket with the bearer token; the brain checks it before upgrading.
  func webSocket(_ path: String) -> URLSessionWebSocketTask {
    var req = request(path, method: "GET")
    var parts = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
    parts.scheme = parts.scheme == "https" ? "wss" : "ws"
    req.url = parts.url
    return session.webSocketTask(with: req)
  }

  private func request(_ path: String, method: String) -> URLRequest {
    var req = URLRequest(url: url(path))
    req.httpMethod = method
    req.timeoutInterval = 30
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    return req
  }

  private func call<T: Decodable, B: Encodable>(_ path: String, method: String, body: B?) async throws -> T {
    var req = request(path, method: method)
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONEncoder().encode(body)
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: req)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as URLError where error.code == .cancelled {
      throw CancellationError()
    } catch {
      throw APIError(status: 0, message: "Couldn't reach Hatbot.")
    }
    try check(response, data: data, path: path)
    do {
      return try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("{}".utf8) : data)
    } catch {
      throw APIError(status: 0, message: "Hatbot sent something this app doesn't understand.")
    }
  }

  private func check(_ response: URLResponse, data: Data, path: String) throws {
    guard let http = response as? HTTPURLResponse else { return }
    guard !(200..<300).contains(http.statusCode) else { return }
    if http.statusCode == 401 && !path.hasPrefix("/auth/") { onUnauthorized() }
    let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
    throw APIError(status: http.statusCode, message: message ?? "HTTP \(http.statusCode)")
  }
}
