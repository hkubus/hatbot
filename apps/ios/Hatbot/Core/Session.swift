// Which brain the app talks to, and its bearer token. Signing in trades password + TOTP for a
// token named after the device (POST /auth/login with client "app").
import Foundation
import Observation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Where the token lives: the Keychain on iOS, memory in tests.
protocol TokenVault: Sendable {
  func load() -> String?
  func save(_ token: String)
  func clear()
}

@MainActor
@Observable
final class Session {
  nonisolated static let serverKey = "server"

  /// The signed-in app state; nil shows the sign-in screen.
  private(set) var store: AppStore?
  var server: String

  @ObservationIgnored private let vault: TokenVault
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let cache: DiskCache?
  @ObservationIgnored private let urlSession: URLSession

  init(vault: TokenVault, defaults: UserDefaults = .standard, cacheDir: URL? = nil, urlSession: URLSession = .hatbot) {
    self.vault = vault
    self.defaults = defaults
    self.urlSession = urlSession
    cache = cacheDir.map(DiskCache.init(dir:))
    server = defaults.string(forKey: Self.serverKey) ?? ""
    if let url = API.serverURL(from: server), let token = vault.load() {
      store = AppStore(api: makeAPI(url, token: token), cache: cache)
    }
  }

  func signIn(password: String, code: String, device: String) async throws {
    guard let url = API.serverURL(from: server) else {
      if API.isPlainHTTP(server) {
        throw APIError(
          status: 0, message: "Use your Hatbot's https address. Over http, your password and token would travel unencrypted.")
      }
      throw APIError(status: 0, message: "Enter your Hatbot's address.")
    }
    let anonymous = API(server: url, token: nil, session: urlSession)
    let me: Me = try await anonymous.get("/auth/me")
    if !me.setupDone {
      throw APIError(status: 0, message: "Finish setting up Hatbot in the web app first.")
    }
    struct Body: Encodable {
      let password: String
      let totp: String
      let client = "app"
      let device: String
    }
    let res: LoginResponse = try await anonymous.post(
      "/auth/login", body: Body(password: password, totp: code, device: device))
    guard let token = res.token else {
      throw APIError(status: 0, message: "This Hatbot is too old for the app. Update it from Settings on the web.")
    }
    vault.save(token)
    server = url.absoluteString
    defaults.set(server, forKey: Self.serverKey)
    // What another brain, or another you, showed before isn't yours to see.
    cache?.clear()
    store = AppStore(api: makeAPI(url, token: token), cache: cache)
  }

  /// Ends the token on the brain too, when it's reachable.
  func signOut() async {
    guard let store else { return }
    store.disconnect()
    try? await store.api.post("/auth/logout")
    forget()
  }

  /// The brain no longer accepts the token.
  private func forget() {
    store?.close()
    store = nil
    vault.clear()
    cache?.clear()
    // Files opened from the chat, and what URLSession kept of attachments and screenshots.
    try? FileManager.default.removeItem(at: DiskCache.openedFiles)
    urlSession.configuration.urlCache?.removeAllCachedResponses()
  }

  private func makeAPI(_ url: URL, token: String) -> API {
    API(server: url, token: token, session: urlSession) { [weak self] in
      Task { @MainActor in
        // Only while it's still this token's session: a late answer to an older one mustn't sign you out.
        guard let self, self.store?.api.token == token else { return }
        self.forget()
      }
    }
  }
}

extension URLSession {
  /// The app's. URLSession.shared keeps about 10 MB on disk and nothing over about 500 KB, so a photo
  /// opened full screen downloaded again each time; a sent file is now kept for good.
  static let hatbot: URLSession = {
    let config = URLSessionConfiguration.default
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("URLs", isDirectory: true)
    #if canImport(FoundationNetworking)
      config.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 200 << 20, diskPath: dir.path)
    #else
      config.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 200 << 20, directory: dir)
    #endif
    return URLSession(configuration: config)
  }()
}
