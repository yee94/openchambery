import Social
import UniformTypeIdentifiers

class ShareViewController: SLComposeServiceViewController {
    private var target: [String: Any]?

    override func viewDidLoad() {
        super.viewDidLoad()
        target = OpenChamberShareStore.target()
        placeholder = target.map { "Send to \($0["name"] as? String ?? "assistant")" } ?? "Choose a default share assistant in OpenChamber"
    }

    override func isContentValid() -> Bool { target != nil }

    override func didSelectPost() {
        guard let target else {
            extensionContext?.cancelRequest(withError: ShareError.missingTarget)
            return
        }
        collect { result in
            switch result {
            case .success(let items):
                defer { Self.removeTemporaryFiles(items) }
                do {
                    let envelope = try OpenChamberShareStore.write(target: target, text: self.contentText, items: items)
                    guard let url = URL(string: "openchamber://share/\(envelope.operationID)") else {
                        self.extensionContext?.completeRequest(returningItems: nil)
                        return
                    }
                    self.extensionContext?.open(url) { _ in self.extensionContext?.completeRequest(returningItems: nil) }
                } catch {
                    self.extensionContext?.cancelRequest(withError: error)
                }
            case .failure(let error):
                self.extensionContext?.cancelRequest(withError: error)
            }
        }
    }

    override func configurationItems() -> [Any]! {
        guard let target else { return [] }
        let item = SLComposeSheetConfigurationItem()
        item?.title = "Assistant"
        item?.value = "\(target["name"] as? String ?? "") · \(target["serverLabel"] as? String ?? "")"
        return [item as Any]
    }

    private func collect(completion: @escaping (Result<[(URL, String, String)], Error>) -> Void) {
        let providers = extensionContext?.inputItems.compactMap { ($0 as? NSExtensionItem)?.attachments }.flatMap { $0 } ?? []
        let imageProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        guard imageProviders.count <= OpenChamberShareStore.maximumImages else {
            completion(.failure(ShareError.tooManyImages))
            return
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var files: [(URL, String, String)] = []
        var failure: Error?
        for provider in imageProviders {
            let typeIdentifier = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true } ?? UTType.image.identifier
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                defer { group.leave() }
                guard let url else {
                    lock.lock()
                    if failure == nil { failure = ShareError.imageUnavailable }
                    lock.unlock()
                    return
                }
                let type = UTType(typeIdentifier)
                let suggestedExtension = URL(fileURLWithPath: provider.suggestedName ?? "").pathExtension
                let fileExtension = Self.safeExtension(url.pathExtension.isEmpty ? (suggestedExtension.isEmpty ? Self.safeExtension(type) : suggestedExtension) : url.pathExtension)
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
                do {
                    try FileManager.default.copyItem(at: url, to: temporary)
                    guard let mime = Self.imageMIME(for: temporary) else {
                        try? FileManager.default.removeItem(at: temporary)
                        lock.lock()
                        if failure == nil { failure = ShareError.unrecognizedImage }
                        lock.unlock()
                        return
                    }
                    lock.lock()
                    files.append((temporary, provider.suggestedName ?? "shared-image.\(fileExtension)", mime))
                    lock.unlock()
                } catch {
                    try? FileManager.default.removeItem(at: temporary)
                    lock.lock()
                    if failure == nil { failure = ShareError.imageUnavailable }
                    lock.unlock()
                }
            }
        }
        group.notify(queue: .main) {
            lock.lock()
            let collected = files
            let collectedFailure = failure
            lock.unlock()
            if let collectedFailure {
                Self.removeTemporaryFiles(collected)
                completion(.failure(collectedFailure))
                return
            }
            completion(.success(collected))
        }
    }

    private static func safeExtension(_ value: String) -> String {
        let sanitized = String(value.filter { $0.isLetter || $0.isNumber }).lowercased()
        return sanitized.isEmpty ? "img" : sanitized
    }

    private static func safeExtension(_ type: UTType?) -> String {
        let ext = type?.preferredFilenameExtension ?? "img"
        return safeExtension(ext)
    }

    private static func imageMIME(for file: URL) -> String? {
        guard let input = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? input.close() }
        guard let data = try? input.read(upToCount: 64) else { return nil }
        switch file.pathExtension.lowercased() {
        case "jpg", "jpeg":
            return data.starts(with: Data([0xff, 0xd8, 0xff])) ? "image/jpeg" : nil
        case "png":
            return data.starts(with: Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png" : nil
        case "gif":
            return data.starts(with: Data("GIF87a".utf8)) || data.starts(with: Data("GIF89a".utf8)) ? "image/gif" : nil
        case "webp":
            return data.starts(with: Data("RIFF".utf8)) && data.count >= 12 && data.subdata(in: 8..<12) == Data("WEBP".utf8) ? "image/webp" : nil
        case "heic", "heif":
            return hasHEICSignature(data) ? "image/heic" : nil
        default:
            return nil
        }
    }

    private static func hasHEICSignature(_ data: Data) -> Bool {
        guard data.count >= 16, data.subdata(in: 4..<8) == Data("ftyp".utf8) else { return false }
        let boxSize = data.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        let end = min(data.count, boxSize)
        guard end >= 16 else { return false }
        let brands = Set(["heic", "heix", "hevc", "hevx"])
        return stride(from: 8, to: end - 3, by: 4).contains { offset in
            guard let brand = String(data: data.subdata(in: offset..<(offset + 4)), encoding: .ascii) else { return false }
            return brands.contains(brand)
        }
    }

    private static func removeTemporaryFiles(_ files: [(URL, String, String)]) {
        for file in files { try? FileManager.default.removeItem(at: file.0) }
    }
}
