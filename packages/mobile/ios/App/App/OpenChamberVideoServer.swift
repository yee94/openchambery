import Foundation
import Network

/// Loopback-only HTTP adapter for WebKit/AVFoundation byte-range reads.
/// The renderer owns remote paths/auth/Relay; native sees opaque IDs and bounded bytes.
final class OpenChamberVideoServer {
    static let maxRangeBytes = 1024 * 1024
    private let queue = DispatchQueue(label: "com.openchamber.video.http")
    private let assetId: String
    private let emit: ([String: Any]) -> Void
    private var listener: NWListener?
    private var pending: [String: NWConnection] = [:]
    private var headRequests = Set<String>()
    private var stopped = false

    init(assetId: String, emit: @escaping ([String: Any]) -> Void) {
        self.assetId = assetId
        self.emit = emit
    }

    func start(completion: @escaping (Result<String, Error>) -> Void) {
        queue.async {
            do {
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
                let listener = try NWListener(using: parameters)
                self.listener = listener
                var completed = false
                listener.stateUpdateHandler = { state in
                    guard !completed else { return }
                    switch state {
                    case .ready:
                        completed = true
                        listener.stateUpdateHandler = nil
                        guard !self.stopped, let port = listener.port else {
                            completion(.failure(URLError(.cancelled))); return
                        }
                        completion(.success("http://127.0.0.1:\(port.rawValue)/\(self.assetId)"))
                    case .failed(let error): completed = true; listener.stateUpdateHandler = nil; completion(.failure(error))
                    case .cancelled: completed = true; listener.stateUpdateHandler = nil; completion(.failure(URLError(.cancelled)))
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
                listener.start(queue: self.queue)
            } catch { completion(.failure(error)) }
        }
    }

    private func accept(_ connection: NWConnection) {
        guard !stopped, pending.count < 8 else { connection.cancel(); return }
        let id = UUID().uuidString
        pending[id] = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.cancel(id)
            default: break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, self.pending[id] != nil else { return }
            self.emit(["assetId": self.assetId, "requestId": id, "cancelled": true])
            self.send(id, status: 504, data: Data())
        }
        receiveHeader(connection, id: id, received: Data())
    }

    private func receiveHeader(_ connection: NWConnection, id: String, received: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] chunk, _, complete, error in
            guard let self, self.pending[id] != nil else { return }
            var bytes = received
            if let chunk { bytes.append(chunk) }
            guard bytes.count <= 16 * 1024 else { self.send(id, status: 431, data: Data()); return }
            if let end = bytes.range(of: Data("\r\n\r\n".utf8)), let header = String(data: bytes[..<end.lowerBound], encoding: .utf8) {
                let lines = header.components(separatedBy: "\r\n")
                let request = (lines.first ?? "").split(separator: " ")
                guard request.count == 3, request[1] == "/\(self.assetId)", request[2] == "HTTP/1.1" else {
                    self.send(id, status: 404, data: Data()); return
                }
                let method = String(request[0])
                guard method == "GET" || method == "HEAD" else { self.send(id, status: 405, data: Data()); return }
                var range: String?
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":") else { continue }
                    if line[..<colon].lowercased() == "range" {
                        guard range == nil else { self.send(id, status: 400, data: Data()); return }
                        range = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    }
                }
                if let range, range.range(of: #"^bytes=\d*-\d*$"#, options: .regularExpression) == nil {
                    self.send(id, status: 400, data: Data()); return
                }
                if method == "HEAD" { self.headRequests.insert(id) }
                self.emit(["assetId": self.assetId, "requestId": id, "method": method, "range": range ?? "bytes=0-"])
                // There is one request per connection. Detect a seek/disconnect while
                // the renderer is fetching; do not leave that Relay request alive.
                connection.receive(minimumIncompleteLength: 1, maximumLength: 1) { [weak self] _, _, _, _ in self?.cancel(id) }
                return
            }
            if complete || error != nil { self.cancel(id); return }
            self.receiveHeader(connection, id: id, received: bytes)
        }
    }

    func respond(requestId: String, status: Int, contentType: String?, contentRange: String?, contentLength: Int?, data: Data) {
        queue.async {
            guard self.pending[requestId] != nil else { return }
            let isHead = self.headRequests.contains(requestId)
            guard data.count <= Self.maxRangeBytes,
                  [200, 206, 416, 502].contains(status),
                  contentLength == nil || contentLength! >= 0,
                  isHead || contentLength == nil || contentLength == data.count,
                  [contentType, contentRange].compactMap({ $0 }).allSatisfy({ !$0.contains("\r") && !$0.contains("\n") && !$0.contains("\0") }) else {
                self.send(requestId, status: 502, data: Data()); return
            }
            self.send(requestId, status: status, data: data, contentType: contentType,
                      contentRange: contentRange, contentLength: contentLength)
        }
    }

    private func send(_ id: String, status: Int, data: Data, contentType: String? = nil, contentRange: String? = nil, contentLength: Int? = nil) {
        guard let connection = pending.removeValue(forKey: id) else { return }
        let isHead = headRequests.remove(id) != nil
        var header = "HTTP/1.1 \(status) \(status == 206 ? "Partial Content" : status == 200 ? "OK" : "Error")\r\n"
        header += "Connection: close\r\nCache-Control: no-store\r\nAccept-Ranges: bytes\r\n"
        header += "Content-Length: \(contentLength ?? data.count)\r\n"
        if let contentType { header += "Content-Type: \(contentType)\r\n" }
        if let contentRange { header += "Content-Range: \(contentRange)\r\n" }
        header += "\r\n"
        var output = Data(header.utf8)
        if !isHead { output.append(data) }
        connection.send(content: output, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func cancel(_ id: String) {
        guard let connection = pending.removeValue(forKey: id) else { return }
        headRequests.remove(id)
        emit(["assetId": assetId, "requestId": id, "cancelled": true])
        connection.cancel()
    }

    func stop() {
        queue.async {
            self.stopped = true
            self.listener?.cancel()
            self.listener = nil
            for id in Array(self.pending.keys) { self.cancel(id) }
        }
    }
}
