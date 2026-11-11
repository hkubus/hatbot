import Foundation

extension AppStore {
  @discardableResult
  func loadPlugins() async throws -> [PluginInfo] {
    let list: [PluginInfo] = try await api.get("/plugins")
    plugins = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, p in p })
    return list
  }

  /// False only once it's known to be off, as on the web: nothing hides while the list loads.
  func pluginOn(_ id: String) -> Bool {
    plugins[id]?.enabled != false
  }

  /// Installed from a forge rather than shipped with Hatbot: their pages are the web app's.
  var installedPlugins: [PluginInfo] {
    plugins.values.filter { $0.source != nil }.sorted { ($0.name, $0.id) < ($1.name, $1.id) }
  }
}

extension API {
  /// The web app at `path`, signed in by a one-time link from this app's token that lasts a minute.
  func webLink(to path: String) async throws -> URL {
    struct Link: Decodable { let url: String }
    let link: Link = try await post("/auth/link", body: Empty())
    // The link signs in whoever has it, so never over plain http.
    guard var parts = URLComponents(string: link.url), parts.scheme?.lowercased() == "https", parts.host != nil else {
      throw APIError(status: 0, message: "Hatbot's public address isn't https, so the app can't open its web pages.")
    }
    parts.percentEncodedQuery = "to=\(Self.query(path))"
    guard let url = parts.url else { throw APIError(status: 0, message: "Hatbot sent something this app doesn't understand.") }
    return url
  }
}

/// Where the web view of an installed plugin's page may go: anywhere on Hatbot's own site, where it's
/// signed in. A link elsewhere opens outside the app, and nothing else loads.
enum SitePage: Equatable, Sendable {
  case allow
  case open(URL)
  case refuse

  /// `mainFrame`: nil for a new window. `link`: a link you followed. `site`: the address it was opened at.
  static func decide(_ url: URL, mainFrame: Bool?, link: Bool, site: URL) -> Self {
    let web = ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    guard let mainFrame else { return web ? .open(url) : .refuse }
    if sameSite(url, site) { return .allow }
    return mainFrame && link && web ? .open(url) : .refuse
  }

  static func sameSite(_ a: URL, _ b: URL) -> Bool {
    a.scheme?.lowercased() == b.scheme?.lowercased() && a.host()?.lowercased() == b.host()?.lowercased()
      && a.port == b.port
  }
}
