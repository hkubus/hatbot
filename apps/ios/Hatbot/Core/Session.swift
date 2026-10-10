// Which brain the app talks to, and its bearer token. Signing in trades password + TOTP for a
// token named after the device (POST /auth/login with client "app").
import Foundation
import Observation

/// Where the token lives: the Keychain on iOS, memory in tests.
protocol TokenVault: Sendable {
  func load() -> String?
  func save(_ token: String)
  func clear()
}

@MainActor
@Observable
final class Session {
  static let serverKey = "server"

  /// The signed-in app state; nil shows the sign-in screen.
  private(set) var store: AppStore?
  var server: String

  @ObservationIgnored private let vault: TokenVault
  @ObservationIgnored private let defaults: UserDefaults

  init(vault: TokenVault, defaults: UserDefaults = .standard) {
    self.vault = vault
    self.defaults = defaults
    server = defaults.string(forKey: Self.serverKey) ?? ""
    if let url = API.serverURL(from: server), let token = vault.load() {
      store = AppStore(api: makeAPI(url, token: token))
    }
  }

  func signIn(password: String, code: String, device: String) async throws {
    guard let url = API.serverURL(from: server) else {
      throw APIError(status: 0, message: "Enter your Hatbot's address.")
    }
    let anonymous = API(server: url, token: nil)
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
    store = AppStore(api: makeAPI(url, token: token))
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
    store?.disconnect()
    store = nil
    vault.clear()
  }

  private func makeAPI(_ url: URL, token: String) -> API {
    API(server: url, token: token) { [weak self] in
      Task { @MainActor in self?.forget() }
    }
  }
}
