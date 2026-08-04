import Foundation
import WebKit

/// Serves progressive virtual image bytes for `openchamber-asset://v/{assetId}`.
/// Incremental `didReceive` data delivery so WKWebView can decode images as chunks arrive.
final class OpenChamberVirtualAssetHandler: NSObject, WKURLSchemeHandler {
    private let workQueue = DispatchQueue(label: "com.openchamber.virtual-asset.handler", qos: .userInitiated)
    /// Weak-task bookkeeping: ObjectIdentifier of the scheme task → reader.
    private var activeReaders: [ObjectIdentifier: OpenChamberVirtualAssetStore.Reader] = [:]
    private let readersLock = NSLock()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let assetId = OpenChamberVirtualAssetStore.extractAssetId(from: url) else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        guard let started = OpenChamberVirtualAssetStore.beginRead(assetId: assetId) else {
            let response = HTTPURLResponse(
                url: url,
                statusCode: 404,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"]
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didFinish()
            return
        }

        let reader = started.reader
        let taskKey = ObjectIdentifier(urlSchemeTask as AnyObject)
        readersLock.lock()
        activeReaders[taskKey] = reader
        readersLock.unlock()

        let headers: [String: String] = [
            "Content-Type": started.mime,
            "Cache-Control": "no-store",
            "Accept-Ranges": "none",
            "X-Content-Type-Options": "nosniff",
        ]
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!

        // Response headers first; body is streamed as append() fills the queue.
        urlSchemeTask.didReceive(response)

        workQueue.async { [weak self] in
            guard let self else { return }
            while true {
                if reader.stopped {
                    OpenChamberVirtualAssetStore.endRead(assetId: assetId, reader: reader)
                    self.clearReader(taskKey: taskKey)
                    return
                }
                guard let chunk = OpenChamberVirtualAssetStore.takeChunk(assetId: assetId, reader: reader) else {
                    if reader.stopped {
                        self.clearReader(taskKey: taskKey)
                        return
                    }
                    // Finished or cancelled with no more data.
                    if !reader.stopped {
                        urlSchemeTask.didFinish()
                    }
                    self.clearReader(taskKey: taskKey)
                    return
                }
                if reader.stopped {
                    OpenChamberVirtualAssetStore.endRead(assetId: assetId, reader: reader)
                    self.clearReader(taskKey: taskKey)
                    return
                }
                urlSchemeTask.didReceive(chunk)
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskKey = ObjectIdentifier(urlSchemeTask as AnyObject)
        readersLock.lock()
        let reader = activeReaders.removeValue(forKey: taskKey)
        readersLock.unlock()
        if let reader {
            OpenChamberVirtualAssetStore.stopReader(reader)
        }
    }

    private func clearReader(taskKey: ObjectIdentifier) {
        readersLock.lock()
        activeReaders.removeValue(forKey: taskKey)
        readersLock.unlock()
    }
}
