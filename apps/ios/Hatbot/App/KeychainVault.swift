// The bearer token in the Keychain, readable only on this device once it's been unlocked. With an
// App Group it's kept in the group's access group, so the share extension can send as you.
import Foundation
import Security

struct KeychainVault: TokenVault {
  var accessGroup: String? = AppGroup.id

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "hatbot",
      kSecAttrAccount as String: "token",
    ]
  }

  func load() -> String? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  /// The token is in the group already.
  var isShared: Bool {
    guard let accessGroup else { return false }
    var q = query
    q[kSecAttrAccessGroup as String] = accessGroup
    return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
  }

  func save(_ token: String) {
    clear()
    var q = query
    q[kSecValueData as String] = Data(token.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
    if SecItemAdd(q as CFDictionary, nil) != errSecSuccess && accessGroup != nil {
      // Signed without the group after all: keep it to the app.
      q[kSecAttrAccessGroup as String] = nil
      SecItemAdd(q as CFDictionary, nil)
    }
  }

  /// Deletes it from every access group this app can reach.
  func clear() {
    SecItemDelete(query as CFDictionary)
  }
}
