import Foundation

/// In-memory progressive byte queues for virtual image assets.
/// Opaque asset IDs only — never stores host paths, credentials, or tunnel keys.
enum OpenChamberVirtualAssetStore {
    static let scheme = "openchamber-asset"
    static let urlHost = "v"

    /// Incomplete assets expire this long after last activity.
    static let ttlSeconds: TimeInterval = 120
    static let maxConcurrentAssets = 16
    /// Hard ceiling per asset body.
    static let maxAssetBytes = 32 * 1024 * 1024
    /// Pending unread queue size before append waits / rejects (backpressure).
    static let maxQueuedBytes = 4 * 1024 * 1024
    static let appendWaitSeconds: TimeInterval = 15
    static let assetIdPattern = #"^[A-Za-z0-9_-]{8,80}$"#
    /// image/* only — type/subtype form, optional +suffix, no parameters (matches Electron).
    private static let imageMimePattern = #"^image/[a-z0-9][a-z0-9!#$&\-^_.+]*$"#

    private static let lock = NSLock()
    private static var assets: [String: Asset] = [:]
    private static var pruneTimer: Timer?

    private final class Asset {
        let assetId: String
        let mime: String
        let createdAt: Date
        var lastActivity: Date
        var finished = false
        var cancelled = false
        var totalBytes = 0
        var queuedBytes = 0
        var chunks: [Data] = []
        var waiters: [DispatchSemaphore] = []
        /// Tasks currently reading this asset (scheme handlers).
        var readers: [ObjectIdentifier: Reader] = [:]

        init(assetId: String, mime: String) {
            self.assetId = assetId
            self.mime = mime
            let now = Date()
            self.createdAt = now
            self.lastActivity = now
        }
    }

    final class Reader {
        let id = ObjectIdentifier(NSObject())
        var stopped = false
    }

    enum StoreError: LocalizedError {
        case invalidAssetId
        case invalidMime
        case duplicate
        case limitReached
        case notFound
        case cancelled
        case finished
        case tooLarge
        case backpressure
        case invalidChunk

        var errorDescription: String? {
            switch self {
            case .invalidAssetId: return "A valid assetId is required."
            case .invalidMime: return "A valid mime is required."
            case .duplicate: return "assetId already exists."
            case .limitReached: return "Virtual asset concurrency limit reached."
            case .notFound: return "Unknown assetId."
            case .cancelled: return "Asset was cancelled."
            case .finished: return "Asset already finished."
            case .tooLarge: return "Asset exceeds maximum size."
            case .backpressure: return "Asset queue backpressure timeout."
            case .invalidChunk: return "Invalid base64 chunk."
            }
        }
    }

    static func url(for assetId: String) -> String {
        "\(scheme)://\(urlHost)/\(assetId)"
    }

    static func extractAssetId(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let host = (url.host ?? "").lowercased()
        guard host == urlHost else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        guard let raw = parts.first, !raw.isEmpty else { return nil }
        return raw.removingPercentEncoding ?? raw
    }

    /// Normalize and validate image-only MIME (image/*, ≤128, no CR/LF/NUL, strict token).
    static func normalizeImageMime(_ mime: String) -> String? {
        let normalized = mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.isEmpty || normalized.count > 128 { return nil }
        if normalized.contains("\n") || normalized.contains("\r") || normalized.contains("\0") { return nil }
        guard normalized.hasPrefix("image/") else { return nil }
        guard normalized.range(of: imageMimePattern, options: [.regularExpression, .caseInsensitive]) != nil else {
            return nil
        }
        return normalized
    }

    static func create(assetId: String, mime: String) throws -> String {
        guard assetId.range(of: assetIdPattern, options: .regularExpression) != nil else {
            throw StoreError.invalidAssetId
        }
        guard let normalizedMime = normalizeImageMime(mime) else {
            throw StoreError.invalidMime
        }

        lock.lock()
        defer { lock.unlock() }
        pruneExpiredLocked(now: Date())
        if assets[assetId] != nil { throw StoreError.duplicate }
        if assets.count >= maxConcurrentAssets { throw StoreError.limitReached }
        assets[assetId] = Asset(assetId: assetId, mime: normalizedMime)
        schedulePruneLocked()
        return url(for: assetId)
    }

    static func append(assetId: String, base64 chunk: String) throws {
        let data = try decodeBase64(chunk)
        if data.isEmpty { return }

        let deadline = Date().addingTimeInterval(appendWaitSeconds)
        while true {
            lock.lock()
            pruneExpiredLocked(now: Date())
            guard let asset = assets[assetId] else {
                lock.unlock()
                throw StoreError.notFound
            }
            if asset.cancelled {
                lock.unlock()
                throw StoreError.cancelled
            }
            if asset.finished {
                lock.unlock()
                throw StoreError.finished
            }
            if asset.totalBytes + data.count > maxAssetBytes {
                lock.unlock()
                throw StoreError.tooLarge
            }
            if asset.queuedBytes + data.count <= maxQueuedBytes {
                asset.chunks.append(data)
                asset.queuedBytes += data.count
                asset.totalBytes += data.count
                asset.lastActivity = Date()
                wakeWaitersLocked(asset)
                lock.unlock()
                return
            }
            // Backpressure: wait for readers to drain.
            let waiter = DispatchSemaphore(value: 0)
            asset.waiters.append(waiter)
            lock.unlock()
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 {
                removeWaiter(assetId: assetId, waiter: waiter)
                throw StoreError.backpressure
            }
            let timeout = DispatchTime.now() + remaining
            if waiter.wait(timeout: timeout) == .timedOut {
                removeWaiter(assetId: assetId, waiter: waiter)
                throw StoreError.backpressure
            }
        }
    }

    static func finish(assetId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let asset = assets[assetId] else { throw StoreError.notFound }
        if asset.cancelled { throw StoreError.cancelled }
        asset.finished = true
        asset.lastActivity = Date()
        wakeWaitersLocked(asset)
    }

    static func cancel(assetId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let asset = assets[assetId] else { return }
        asset.cancelled = true
        asset.finished = true
        asset.chunks.removeAll(keepingCapacity: false)
        asset.queuedBytes = 0
        for reader in asset.readers.values {
            reader.stopped = true
        }
        wakeWaitersLocked(asset)
        // Drop when no active readers remain.
        if asset.readers.isEmpty {
            assets.removeValue(forKey: assetId)
        }
    }

    // MARK: - Scheme handler integration

    /// One consumer per asset — a second reader is rejected so the shared queue is not sharded.
    static func beginRead(assetId: String) -> (mime: String, reader: Reader)? {
        lock.lock()
        defer { lock.unlock() }
        pruneExpiredLocked(now: Date())
        guard let asset = assets[assetId], !asset.cancelled else { return nil }
        if !asset.readers.isEmpty { return nil }
        let reader = Reader()
        asset.readers[ObjectIdentifier(reader)] = reader
        asset.lastActivity = Date()
        return (asset.mime, reader)
    }

    /// Blocks until a chunk is available, the asset finishes empty, or cancel/stop.
    /// Returns nil when the stream ends (finish with no more data, cancel, or stop).
    static func takeChunk(assetId: String, reader: Reader, waitSeconds: TimeInterval = 30) -> Data? {
        let deadline = Date().addingTimeInterval(waitSeconds)
        while true {
            lock.lock()
            guard let asset = assets[assetId] else {
                lock.unlock()
                return nil
            }
            if reader.stopped || asset.cancelled {
                endReaderLocked(assetId: assetId, reader: reader)
                lock.unlock()
                return nil
            }
            if !asset.chunks.isEmpty {
                let data = asset.chunks.removeFirst()
                asset.queuedBytes = max(0, asset.queuedBytes - data.count)
                asset.lastActivity = Date()
                // Unblock append waiters after drain.
                if !asset.waiters.isEmpty {
                    let waiter = asset.waiters.removeFirst()
                    waiter.signal()
                }
                lock.unlock()
                return data
            }
            if asset.finished {
                endReaderLocked(assetId: assetId, reader: reader)
                lock.unlock()
                return nil
            }
            let waiter = DispatchSemaphore(value: 0)
            asset.waiters.append(waiter)
            lock.unlock()
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 {
                removeWaiter(assetId: assetId, waiter: waiter)
                return nil
            }
            _ = waiter.wait(timeout: .now() + remaining)
        }
    }

    static func endRead(assetId: String, reader: Reader) {
        lock.lock()
        endReaderLocked(assetId: assetId, reader: reader)
        lock.unlock()
    }

    static func stopReader(_ reader: Reader) {
        reader.stopped = true
        lock.lock()
        for asset in assets.values {
            if asset.readers[ObjectIdentifier(reader)] != nil {
                wakeWaitersLocked(asset)
            }
        }
        lock.unlock()
    }

    // MARK: - Internals

    private static func endReaderLocked(assetId: String, reader: Reader) {
        guard let asset = assets[assetId] else { return }
        asset.readers.removeValue(forKey: ObjectIdentifier(reader))
        if (asset.finished || asset.cancelled) && asset.readers.isEmpty {
            assets.removeValue(forKey: assetId)
        }
    }

    private static func wakeWaitersLocked(_ asset: Asset) {
        let pending = asset.waiters
        asset.waiters.removeAll(keepingCapacity: false)
        for waiter in pending {
            waiter.signal()
        }
    }

    private static func removeWaiter(assetId: String, waiter: DispatchSemaphore) {
        lock.lock()
        if let asset = assets[assetId] {
            asset.waiters.removeAll { $0 === waiter }
        }
        lock.unlock()
    }

    private static func pruneExpiredLocked(now: Date) {
        let expired = assets.filter { _, asset in
            now.timeIntervalSince(asset.lastActivity) > ttlSeconds
        }
        for (id, asset) in expired {
            asset.cancelled = true
            asset.finished = true
            asset.chunks.removeAll(keepingCapacity: false)
            asset.queuedBytes = 0
            for reader in asset.readers.values {
                reader.stopped = true
            }
            wakeWaitersLocked(asset)
            if asset.readers.isEmpty {
                assets.removeValue(forKey: id)
            }
        }
    }

    private static func schedulePruneLocked() {
        if pruneTimer != nil { return }
        DispatchQueue.main.async {
            lock.lock()
            if pruneTimer == nil {
                let timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
                    lock.lock()
                    pruneExpiredLocked(now: Date())
                    if assets.isEmpty {
                        pruneTimer?.invalidate()
                        pruneTimer = nil
                    }
                    lock.unlock()
                }
                RunLoop.main.add(timer, forMode: .common)
                pruneTimer = timer
            }
            lock.unlock()
        }
    }

    private static func decodeBase64(_ chunk: String) throws -> Data {
        let trimmed = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return Data() }
        // Accept standard and URL-safe base64, with or without padding.
        var normalized = trimmed
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let pad = normalized.count % 4
        if pad != 0 {
            normalized.append(String(repeating: "=", count: 4 - pad))
        }
        guard let data = Data(base64Encoded: normalized, options: [.ignoreUnknownCharacters]) else {
            throw StoreError.invalidChunk
        }
        return data
    }

    #if DEBUG
    static func debugReset() {
        lock.lock()
        assets.removeAll()
        lock.unlock()
    }

    static func debugCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return assets.count
    }
    #endif
}
