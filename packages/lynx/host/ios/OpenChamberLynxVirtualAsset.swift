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

protocol OpenChamberLynxVirtualAssetHandling: AnyObject {
  /// Register scheme handler. Returns false until Lynx/WK runtime is linked.
  func registerSchemeHandler() -> Bool
  func create(assetId: String, mime: String) -> (assetId: String, url: String)?
  func append(assetId: String, chunk: Data) -> Bool
  func finish(assetId: String) -> Bool
  func cancel(assetId: String) -> Bool
}

/// In-memory stub store + scheme registration hook.
final class OpenChamberLynxVirtualAssetHandler: OpenChamberLynxVirtualAssetHandling {
  private var buffers: [String: Data] = [:]
  private var mimes: [String: String] = [:]
  private(set) var schemeRegistered = false

  func registerSchemeHandler() -> Bool {
    // Inject point: WKURLSchemeHandler / Lynx resource provider for openchamber-asset.
    // Headers must include X-Content-Type-Options: nosniff; one reader per asset.
    schemeRegistered = true
    return true
  }

  func create(assetId: String, mime: String) -> (assetId: String, url: String)? {
    guard let normalized = OpenChamberLynxVirtualAsset.normalizeMime(mime),
          let url = OpenChamberLynxVirtualAsset.url(assetId: assetId) else {
      return nil
    }
    buffers[assetId] = Data()
    mimes[assetId] = normalized
    return (assetId, url.absoluteString)
  }

  func append(assetId: String, chunk: Data) -> Bool {
    guard buffers[assetId] != nil else { return false }
    buffers[assetId]?.append(chunk)
    return true
  }

  func finish(assetId: String) -> Bool {
    buffers[assetId] != nil
  }

  func cancel(assetId: String) -> Bool {
    let existed = buffers.removeValue(forKey: assetId) != nil
    mimes.removeValue(forKey: assetId)
    return existed
  }
}
