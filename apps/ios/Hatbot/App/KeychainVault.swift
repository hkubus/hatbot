// The bearer token in the Keychain, readable only on this device once it's been unlocked.
import Foundation
import Security

struct KeychainVault: TokenVault {
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

  func save(_ token: String) {
    clear()
    var q = query
    q[kSecValueData as String] = Data(token.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(q as CFDictionary, nil)
  }

  func clear() {
    SecItemDelete(query as CFDictionary)
  }
}
