import Foundation

enum OpenChamberExpoShareStore {
  static let appGroup = "group.com.yee94.openchamber"
  static let catalogKey = "openchamberShareCatalog"

  static func appGroupAvailable() -> Bool {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) != nil
  }

  static func root() throws -> URL {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      throw ShareError.appGroupUnavailable
    }
    let root = container.appendingPathComponent("share-inbox", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  static func updateCatalog(_ entries: [[String: Any]]) throws {
    let data = try JSONSerialization.data(withJSONObject: entries)
    guard UserDefaults(suiteName: appGroup) != nil else { throw ShareError.appGroupUnavailable }
    UserDefaults(suiteName: appGroup)?.set(data, forKey: catalogKey)
  }

  static func pending() throws -> [[String: Any]] {
    let root = try root()
    let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    var envelopes: [[String: Any]] = []
    for file in files where file.pathExtension == "json" {
      guard let data = try? Data(contentsOf: file),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
      envelopes.append(object)
    }
    return envelopes.sorted { lhs, rhs in
      let a = (lhs["createdAt"] as? NSNumber)?.int64Value ?? 0
      let b = (rhs["createdAt"] as? NSNumber)?.int64Value ?? 0
      return a > b
    }
  }

  static func acknowledge(_ operationID: String) throws {
    let root = try root()
    let file = root.appendingPathComponent("\(operationID).json")
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    var object = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
    object["consumedAt"] = Int64(Date().timeIntervalSince1970 * 1000)
    let data = try JSONSerialization.data(withJSONObject: object)
    try data.write(to: file, options: .atomic)
  }

  static func release(_ operationID: String) throws {
    let root = try root()
    let file = root.appendingPathComponent("\(operationID).json")
    try? FileManager.default.removeItem(at: file)
    let attachments = root.appendingPathComponent(operationID, isDirectory: true)
    try? FileManager.default.removeItem(at: attachments)
  }

  enum ShareError: LocalizedError {
    case appGroupUnavailable
    var errorDescription: String? {
      switch self {
      case .appGroupUnavailable: return "App Group group.com.yee94.openchamber unavailable"
      }
    }
  }
}
