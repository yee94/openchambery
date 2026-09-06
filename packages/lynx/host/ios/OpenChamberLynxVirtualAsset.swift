import Foundation

/// `openchamber-asset://v/{assetId}` hooks — Cap OpenChamberVirtualAsset spirit.
/// Register a WKURLSchemeHandler / Lynx resource provider when the SDK is linked.
enum OpenChamberLynxVirtualAsset {
  static let scheme = "openchamber-asset"
  static let mimeMaxLength = 128

  static func url(assetId: String) -> URL? {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "_-")
    guard assetId.count >= 8, assetId.count <= 80,
          assetId.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
      return nil
    }
    return URL(string: "\(scheme)://v/\(assetId)")
  }

  static func normalizeMime(_ mime: String) -> String? {
    let normalized = mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty, normalized.count <= mimeMaxLength else { return nil }
    guard normalized.hasPrefix("image/") else { return nil }
    return normalized
  }
}
