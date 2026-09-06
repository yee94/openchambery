import Foundation
import Security

/// Keychain wrapper — Cap `@aparajita/capacitor-secure-storage` spirit.
/// Mirrors `packages/lynx/src/host/secureStore.ts`.
/// Access: kSecAttrAccessibleWhenUnlocked (Cap KeychainAccess.whenUnlocked = 0).
enum OpenChamberLynxKeychainAccess {
  /// Cap KeychainAccess.whenUnlocked
  static let whenUnlocked = 0
}

protocol OpenChamberLynxSecureStoring: AnyObject {
  func getItem(prefixedKey: String) async -> String?
  func setItem(prefixedKey: String, data: String, access: Int) async -> Bool
  func removeItem(prefixedKey: String) async -> Bool
}

final class OpenChamberLynxSecureStore: OpenChamberLynxSecureStoring {
  private let service = "com.yee94.openchamber.lynx.secure"

  func getItem(prefixedKey: String) async -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: prefixedKey,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func setItem(prefixedKey: String, data: String, access: Int) async -> Bool {
    guard let bytes = data.data(using: .utf8) else { return false }
    let accessible = access == OpenChamberLynxKeychainAccess.whenUnlocked
      ? kSecAttrAccessibleWhenUnlocked
      : kSecAttrAccessibleWhenUnlocked
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: prefixedKey,
    ]
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = bytes
    add[kSecAttrAccessible as String] = accessible
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  func removeItem(prefixedKey: String) async -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: prefixedKey,
    ]
    let status = SecItemDelete(query as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}
