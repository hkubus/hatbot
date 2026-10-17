// The App Group the app shares with its share extension: the brain's address in shared defaults, and
// the token in a Keychain access group of the same name. SideStore renames the group to
// "group.<bundle prefix>.hatbot.<team id>", so the name is worked out on the device.
import Foundation
import Security

enum AppGroup {
  /// The reverse domain the app is named under: project.yml's BUNDLE_PREFIX, through Info.plist.
  static let prefix = Bundle.main.object(forInfoDictionaryKey: "HatbotBundlePrefix") as? String ?? "com.example"
  static let base = "group.\(prefix).hatbot"

  /// The group as signed, or nil when there is none (then the app keeps things to itself).
  static let id: String? = {
    let candidates = (teamID.map { ["\(base).\($0)"] } ?? []) + [base]
    return candidates.first { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil }
  }()

  /// Where the app keeps what it last saw (DiskCache): the group's caches, or the app's own.
  static var cacheDir: URL? {
    let root =
      id.flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }?
      .appendingPathComponent("Library/Caches", isDirectory: true)
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    return root?.appendingPathComponent("Hatbot", isDirectory: true)
  }

  /// Defaults both see; the app's own when there's no group.
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

  /// Moves what an app from before the group kept to itself into the group, once.
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
  /// The brain as you, for Shortcuts and the share extension: nil before you've signed in in the app.
  static func api() -> API? {
    guard let url = API.serverURL(from: defaults.string(forKey: Session.serverKey) ?? ""),
      let token = KeychainVault().load()
    else { return nil }
    return API(server: url, token: token)
  }
}

/// The widget's and the control's kinds; the app reloads them when what they show changes.
enum WidgetKinds {
  static let status = "\(AppGroup.prefix).hatbot.status"
  static let pause = "\(AppGroup.prefix).hatbot.pause"
}
