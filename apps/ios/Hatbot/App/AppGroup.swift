// SideStore renames the App Group to "group.<bundle prefix>.hatbot.<team id>", so the name is worked
// out on the device.
import Foundation
import Security

enum AppGroup {
  /// project.yml's BUNDLE_PREFIX, through Info.plist.
  static let prefix = Bundle.main.object(forInfoDictionaryKey: "HatbotBundlePrefix") as? String ?? "com.example"
  static let base = "group.\(prefix).hatbot"

  static let id: String? = {
    let candidates = (teamID.map { ["\(base).\($0)"] } ?? []) + [base]
    return candidates.first { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil }
  }()

  static var cacheDir: URL? {
    let root =
      id.flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }?
      .appendingPathComponent("Library/Caches", isDirectory: true)
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    return root?.appendingPathComponent("Hatbot", isDirectory: true)
  }

  static var defaults: UserDefaults {
    id.flatMap { UserDefaults(suiteName: $0) } ?? .standard
  }

  /// The signing team, from the access group a fresh Keychain item gets ("TEAMID.bundle.id").
  private static let teamID: String? = {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "hatbot",
      kSecAttrAccount as String: "team",
      kSecReturnAttributes as String: true,
    ]
    var result: CFTypeRef?
    var status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = Data()
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(add as CFDictionary, &result)
    }
    guard status == errSecSuccess, let attrs = result as? [String: Any],
      let group = attrs[kSecAttrAccessGroup as String] as? String,
      let team = group.split(separator: ".").first
    else { return nil }
    return String(team)
  }()

  static func migrate(vault: KeychainVault) {
    guard id != nil else { return }
    let shared = defaults
    if shared.string(forKey: Session.serverKey) == nil,
      let server = UserDefaults.standard.string(forKey: Session.serverKey)
    {
      shared.set(server, forKey: Session.serverKey)
    }
    if let token = vault.load(), !vault.isShared { vault.save(token) }
  }
}

extension AppGroup {
  static func api() -> API? {
    guard let url = API.serverURL(from: defaults.string(forKey: Session.serverKey) ?? ""),
      let token = KeychainVault().load()
    else { return nil }
    return API(server: url, token: token)
  }
}

enum WidgetKinds {
  static let status = "\(AppGroup.prefix).hatbot.status"
  static let pause = "\(AppGroup.prefix).hatbot.pause"
}
