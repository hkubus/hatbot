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

  var isShared: Bool {
    guard let accessGroup else { return false }
    var q = query
    q[kSecAttrAccessGroup as String] = accessGroup
    return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
  }

  /// Changed in place, or added if it isn't there, so the share extension never finds it missing.
  func save(_ token: String) {
    let attributes: [String: Any] = [
      kSecValueData as String: Data(token.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    if let accessGroup {
      var q = query
      q[kSecAttrAccessGroup as String] = accessGroup
      if upsert(q, attributes) {
        // One the app kept to itself before the group gets the same token, so either one read is right.
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        return
      }
    }
    // No group, or signed without it after all: keep it to the app.
    upsert(query, attributes)
  }

  @discardableResult
  private func upsert(_ q: [String: Any], _ attributes: [String: Any]) -> Bool {
    let status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
    if status == errSecSuccess { return true }
    guard status == errSecItemNotFound else { return false }
    return SecItemAdd(q.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess
  }

  /// Deletes it from every access group this app can reach.
  func clear() {
    SecItemDelete(query as CFDictionary)
  }
}
