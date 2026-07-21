import Foundation

struct ShareAttachment: Codable {
    let stagedPath: String
    let originalName: String
    let mime: String
    let byteSize: Int64
}

struct ShareEnvelope: Codable {
    let version: Int
    let operationID: String
    let serverInstanceID: String
    let assistantID: String
    let text: String?
    let attachments: [ShareAttachment]
    let source: String
    let createdAt: Int64
    let expiresAt: Int64
    let consumedAt: Int64?
}

enum OpenChamberShareStore {
    static let appGroup = "group.com.openchamber.app"
    static let catalogKey = "openchamberShareCatalog"
    static let maximumImageBytes = 8 * 1024 * 1024
    static let maximumTotalBytes = 16 * 1024 * 1024
    static let maximumImages = 10
    static let lifetime: TimeInterval = 24 * 60 * 60

    static func root() throws -> URL {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { throw ShareError.appGroupUnavailable }
        let root = container.appendingPathComponent("share-inbox", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    static func catalog() -> [[String: Any]] {
        guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: catalogKey), let value = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return value
    }

    static func updateCatalog(_ entries: [[String: Any]]) throws {
        let data = try JSONSerialization.data(withJSONObject: entries)
        guard UserDefaults(suiteName: appGroup)?.set(data, forKey: catalogKey) != nil else { throw ShareError.appGroupUnavailable }
    }

    static func target(serverInstanceID: String? = nil, assistantID: String? = nil) -> [String: Any]? {
        let entries = catalog().filter { ($0["enabled"] as? Bool) == true }
        if let serverInstanceID, let assistantID, let exact = entries.first(where: { $0["serverInstanceID"] as? String == serverInstanceID && $0["assistantID"] as? String == assistantID }) { return exact }
        return entries.first { ($0["isDefaultShareTarget"] as? Bool) == true }
    }

    static func write(target: [String: Any], text: String?, items: [(URL, String, String)]) throws -> ShareEnvelope {
        guard let server = target["serverInstanceID"] as? String, let assistant = target["assistantID"] as? String else { throw ShareError.missingTarget }
        guard items.count <= maximumImages else { throw ShareError.tooManyImages }
        guard text?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty != nil || !items.isEmpty else { throw ShareError.emptyShare }
        let operationID = UUID().uuidString.lowercased(); let root = try root(); let temporary = root.appendingPathComponent(".\(operationID)", isDirectory: true); let ready = root.appendingPathComponent(operationID, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        var attachments: [ShareAttachment] = []; var total = 0
        do {
            for (index, item) in items.enumerated() {
                guard item.2.hasPrefix("image/") else { throw ShareError.unsupportedAttachment }
                let destination = temporary.appendingPathComponent("\(index)-\(safeName(item.1))")
                let bytes = try copyLimited(from: item.0, to: destination, maximum: maximumImageBytes)
                total += bytes; guard total <= maximumTotalBytes else { throw ShareError.totalTooLarge }
                attachments.append(ShareAttachment(stagedPath: destination.lastPathComponent, originalName: item.1, mime: item.2, byteSize: Int64(bytes)))
            }
            let now = Int64(Date().timeIntervalSince1970 * 1000); let envelope = ShareEnvelope(version: 1, operationID: operationID, serverInstanceID: server, assistantID: assistant, text: text?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, attachments: attachments, source: "ios-share", createdAt: now, expiresAt: now + Int64(lifetime * 1000), consumedAt: nil)
            let data = try JSONEncoder().encode(envelope); try data.write(to: temporary.appendingPathComponent("envelope.json"), options: .atomic)
            try FileManager.default.moveItem(at: temporary, to: ready)
            return envelope
        } catch { try? FileManager.default.removeItem(at: temporary); throw error }
    }

    static func pending() throws -> [ShareEnvelope] { try prune(); return try FileManager.default.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil).compactMap { url in guard !url.lastPathComponent.hasPrefix("."), let data = try? Data(contentsOf: url.appendingPathComponent("envelope.json")), let envelope = try? JSONDecoder().decode(ShareEnvelope.self, from: data), envelope.consumedAt == nil, validAttachments(envelope.attachments) else { return nil }; return resolved(envelope, in: url) } }
    static func acknowledge(_ operationID: String) throws { let url = try operationURL(operationID); let file = url.appendingPathComponent("envelope.json"); guard let data = try? Data(contentsOf: file), var envelope = try? JSONDecoder().decode(ShareEnvelope.self, from: data) else { return }; guard envelope.consumedAt == nil else { return }; envelope = ShareEnvelope(version: envelope.version, operationID: envelope.operationID, serverInstanceID: envelope.serverInstanceID, assistantID: envelope.assistantID, text: envelope.text, attachments: envelope.attachments, source: envelope.source, createdAt: envelope.createdAt, expiresAt: envelope.expiresAt, consumedAt: Int64(Date().timeIntervalSince1970 * 1000)); try JSONEncoder().encode(envelope).write(to: file, options: .atomic) }
    static func release(_ operationID: String) throws { let url = try operationURL(operationID); try? FileManager.default.removeItem(at: url) }
    private static func operationURL(_ operationID: String) throws -> URL { guard operationID.range(of: "^[A-Za-z0-9-]{1,80}$", options: .regularExpression) != nil else { throw ShareError.invalidOperation }; return try root().appendingPathComponent(operationID) }
    private static func resolved(_ envelope: ShareEnvelope, in directory: URL) -> ShareEnvelope { ShareEnvelope(version: envelope.version, operationID: envelope.operationID, serverInstanceID: envelope.serverInstanceID, assistantID: envelope.assistantID, text: envelope.text, attachments: envelope.attachments.map { ShareAttachment(stagedPath: directory.appendingPathComponent($0.stagedPath).path, originalName: $0.originalName, mime: $0.mime, byteSize: $0.byteSize) }, source: envelope.source, createdAt: envelope.createdAt, expiresAt: envelope.expiresAt, consumedAt: envelope.consumedAt) }
    private static func validAttachments(_ attachments: [ShareAttachment]) -> Bool { attachments.allSatisfy { !$0.stagedPath.hasPrefix("/") && !$0.stagedPath.contains("/") && $0.stagedPath == URL(fileURLWithPath: $0.stagedPath).lastPathComponent } }
    static func prune() throws { let now = Int64(Date().timeIntervalSince1970 * 1000); for url in try FileManager.default.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil) { guard !url.lastPathComponent.hasPrefix(".") else { try? FileManager.default.removeItem(at: url); continue }; guard let data = try? Data(contentsOf: url.appendingPathComponent("envelope.json")), let envelope = try? JSONDecoder().decode(ShareEnvelope.self, from: data), envelope.expiresAt > now, validAttachments(envelope.attachments) else { try? FileManager.default.removeItem(at: url); continue } } }
    private static func copyLimited(from source: URL, to destination: URL, maximum: Int) throws -> Int { let input = try FileHandle(forReadingFrom: source); FileManager.default.createFile(atPath: destination.path, contents: nil); let output = try FileHandle(forWritingTo: destination); defer { try? input.close(); try? output.close() }; var total = 0; while true { let data = try input.read(upToCount: 32 * 1024) ?? Data(); if data.isEmpty { break }; total += data.count; guard total <= maximum else { throw ShareError.imageTooLarge }; try output.write(contentsOf: data) }; try output.synchronize(); return total }
    private static func safeName(_ name: String) -> String { String(name.map { $0.isLetter || $0.isNumber || ".-_".contains($0) ? $0 : "_" }) }
}

enum ShareError: LocalizedError { case appGroupUnavailable, missingTarget, tooManyImages, imageTooLarge, totalTooLarge, unsupportedAttachment, imageUnavailable, unrecognizedImage, emptyShare, invalidOperation
    var errorDescription: String? { switch self { case .appGroupUnavailable: return "OpenChamber shared storage is unavailable."; case .missingTarget: return "Choose a default share assistant in OpenChamber before sharing."; case .tooManyImages: return "A share supports up to 10 images."; case .imageTooLarge: return "An image exceeds 8 MB."; case .totalTooLarge: return "Shared images exceed 16 MB."; case .unsupportedAttachment: return "Only image attachments are supported."; case .imageUnavailable: return "The shared image could not be loaded. Try sharing it again."; case .unrecognizedImage: return "The shared image format could not be identified safely."; case .emptyShare: return "Add text or at least one image before sharing."; case .invalidOperation: return "A valid operation ID is required." } }
}

private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }
