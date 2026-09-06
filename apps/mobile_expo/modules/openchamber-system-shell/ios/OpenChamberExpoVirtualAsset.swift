import Foundation

enum OpenChamberExpoVirtualAsset {
  private static var handles: [String: FileHandle] = [:]
  private static var urls: [String: URL] = [:]
  private static let queue = DispatchQueue(label: "com.yee94.openchamber.virtual-asset")

  private static func directory() throws -> URL {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    let dir = base.appendingPathComponent("openchamber-virtual-assets", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  static func create(assetId: String, mime: String) throws -> String {
    try queue.sync {
      let ext = mime.contains("png") ? "png" : mime.contains("jpeg") || mime.contains("jpg") ? "jpg" : mime.contains("heic") ? "heic" : "bin"
      let url = try directory().appendingPathComponent("\(assetId).\(ext)")
      FileManager.default.createFile(atPath: url.path, contents: nil)
      let handle = try FileHandle(forWritingTo: url)
      handles[assetId] = handle
      urls[assetId] = url
      return url.absoluteString
    }
  }

  static func append(assetId: String, base64: String) throws {
    try queue.sync {
      guard let handle = handles[assetId] else { throw AssetError.missing }
      guard let data = Data(base64Encoded: base64) else { throw AssetError.badChunk }
      try handle.write(contentsOf: data)
    }
  }

  static func finish(assetId: String) throws -> String {
    try queue.sync {
      guard let handle = handles.removeValue(forKey: assetId), let url = urls.removeValue(forKey: assetId) else {
        throw AssetError.missing
      }
      try handle.close()
      return url.absoluteString
    }
  }

  static func cancel(assetId: String) throws {
    try queue.sync {
      if let handle = handles.removeValue(forKey: assetId) {
        try? handle.close()
      }
      if let url = urls.removeValue(forKey: assetId) {
        try? FileManager.default.removeItem(at: url)
      }
    }
  }

  enum AssetError: LocalizedError {
    case missing, badChunk
    var errorDescription: String? {
      switch self {
      case .missing: return "virtual asset missing"
      case .badChunk: return "invalid base64 chunk"
      }
    }
  }
}
