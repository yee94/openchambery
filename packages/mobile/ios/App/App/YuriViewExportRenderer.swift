import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers
import WebKit

struct YuriViewExportError: Error {
    let code: String
    let message: String
}

struct YuriViewExportRequest {
    static let limits = ["maxHTMLBytes": 4 * 1024 * 1024, "maxWidth": 2048,
                         "maxHeight": 32768, "maxPixels": 8 * 1024 * 1024]
    let taskId: String
    let html: String
    let width: Int
    let height: Int
    let filename: String
    let pdf: Bool
    let letter: Bool

    init(_ input: [String: Any], pdf: Bool) throws {
        func invalid(_ message: String) -> YuriViewExportError {
            YuriViewExportError(code: "EXPORT_INVALID_INPUT", message: message)
        }
        guard let taskId = input["taskId"] as? String,
              taskId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              let snapshot = input["snapshot"] as? [String: Any],
              let html = snapshot["html"] as? String, !html.isEmpty,
              let filename = input["filename"] as? String,
              !filename.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              filename.utf8.count <= 240, filename != ".", filename != "..",
              filename.rangeOfCharacter(from: .controlCharacters) == nil,
              !filename.contains("/"), !filename.contains("\\") else {
            throw invalid("Invalid task, snapshot or filename")
        }
        func dimension(_ key: String) throws -> Int {
            guard let value = snapshot[key] as? NSNumber,
                  CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
                  value.doubleValue > 0, value.doubleValue.rounded() == value.doubleValue else {
                throw invalid("Snapshot dimensions must be positive integers")
            }
            guard value.doubleValue <= Double(Self.limits[key == "width" ? "maxWidth" : "maxHeight"]!) else {
                throw YuriViewExportError(code: "EXPORT_TOO_LARGE", message: "Snapshot dimensions exceed native limits")
            }
            return value.intValue
        }
        let width = try dimension("width"), height = try dimension("height")
        guard html.utf8.count <= Self.limits["maxHTMLBytes"]!, width * height <= Self.limits["maxPixels"]! else {
            throw YuriViewExportError(code: "EXPORT_TOO_LARGE", message: "Snapshot exceeds native limits")
        }
        if let pageSize = input["pageSize"] {
            guard pdf, let value = pageSize as? String, value == "a4" || value == "letter" else {
                throw invalid("pageSize must be a4 or letter for PDF")
            }
        }
        if pdf {
            let page = input["pageSize"] as? String == "letter" ? CGSize(width: 612, height: 792) : CGSize(width: 595.28, height: 841.89)
            let scale = min(0.75, (page.width - 48) / CGFloat(width))
            let rows = max(1, Int(floor((page.height - 48) / scale)))
            guard (height + rows - 1) / rows <= 128 else {
                throw YuriViewExportError(code: "EXPORT_TOO_LARGE", message: "PDF exceeds 128 pages")
            }
        }
        // The input is a fragment, not a document or an executable web application.
        // CSP + content rules + navigation policy remain the enforcement boundary.
        if html.range(of: "<\\s*(script|iframe|frame|frameset|object|embed|base|link|meta|html|head|body|video|audio)\\b",
                      options: [.regularExpression, .caseInsensitive]) != nil {
            throw YuriViewExportError(code: "EXPORT_FORBIDDEN", message: "Snapshot must contain static self-contained HTML")
        }
        self.taskId = taskId
        self.html = html
        self.width = width
        self.height = height
        self.filename = (filename as NSString).deletingPathExtension + (pdf ? ".pdf" : ".png")
        self.pdf = pdf
        self.letter = input["pageSize"] as? String == "letter"
    }

    var document: String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=\(width),initial-scale=1,maximum-scale=1,user-scalable=no">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
        <style>html,body{margin:0!important;padding:0!important;width:\(width)px!important;min-width:\(width)px!important;height:\(height)px!important;min-height:\(height)px!important}body{overflow:hidden!important}*{animation:none!important;transition:none!important;caret-color:transparent!important}</style>
        </head><body>\(html)</body></html>
        """
    }
}

/// A task-owned renderer. All WebKit/UIKit work is main-thread confined; one
/// viewport tile is retained at a time. PNG has one bounded 32 MiB RGBA canvas.
final class YuriViewExportRenderer: NSObject, WKNavigationDelegate {
    private let request: YuriViewExportRequest
    private let directory: URL
    private let progress: (String, Int?, Int?) -> Void
    private var completion: ((Result<URL, YuriViewExportError>) -> Void)?
    private var webView: WKWebView?
    private var renderHost: UIView?
    private var bitmap: CGContext?
    private var pdfContext: CGContext?
    private var timeout: DispatchWorkItem?
    private var startedNavigation = false
    private var rendering = false
    private var stopped = false
    private var encoding = false
    private var generatingPDF = false
    private var cancellationCompleted: (() -> Void)?
    private var y = 0
    private let encoder = DispatchQueue(label: "com.yuri.view-export.encode", qos: .userInitiated)

    init(request: YuriViewExportRequest, directory: URL,
         progress: @escaping (String, Int?, Int?) -> Void,
         completion: @escaping (Result<URL, YuriViewExportError>) -> Void) {
        self.request = request
        self.directory = directory
        self.progress = progress
        self.completion = completion
    }

    private var output: URL { directory.appendingPathComponent(request.filename) }
    private var pageSize: CGSize { request.letter ? CGSize(width: 612, height: 792) : CGSize(width: 595.28, height: 841.89) }
    private var pdfScale: CGFloat { min(0.75, (pageSize.width - 48) / CGFloat(request.width)) }
    private var pageHeight: Int { Int(floor((pageSize.height - 48) / pdfScale)) }

    func start(in owner: UIView) {
        precondition(Thread.isMainThread)
        guard owner.window != nil else { fail("Renderer owner is not attached"); return }
        progress("preparing", nil, nil)
        let timer = DispatchWorkItem { [weak self] in self?.fail("Snapshot rendering timed out") }
        timeout = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: timer)
        // A content rule blocks all external schemes, including file/custom app
        // protocols. The only exceptions are the inline document and data assets.
        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^about:blank$"},"action":{"type":"ignore-previous-rules"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "YuriViewExport-v1", encodedContentRuleList: rules) { [weak self, weak owner] rules, error in
            guard let self, !self.stopped else { return }
            guard let rules, error == nil, let owner, owner.window != nil else {
                self.fail("Could not initialize isolated renderer"); return
            }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            configuration.userContentController.add(rules)
            let height = min(512, self.request.height)
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: self.request.width, height: height), configuration: configuration)
            view.navigationDelegate = self
            view.isUserInteractionEnabled = false
            view.scrollView.contentInsetAdjustmentBehavior = .never
            view.scrollView.bounces = false
            view.scrollView.showsVerticalScrollIndicator = false
            view.scrollView.showsHorizontalScrollIndicator = false
            view.isOpaque = true
            view.backgroundColor = .white
            // Keep the full viewport inside a live UIKit hierarchy. Do not hide,
            // move off-window, or give it alpha=0: WebKit may then skip painting.
            // Inserting below the app content preserves its focus and scroll.
            let host = UIView(frame: owner.bounds)
            host.isUserInteractionEnabled = false
            host.accessibilityElementsHidden = true
            owner.insertSubview(host, at: 0)
            host.addSubview(view)
            let scale = min(1, owner.bounds.width / CGFloat(self.request.width), owner.bounds.height / CGFloat(height))
            view.transform = CGAffineTransform(scaleX: scale, y: scale)
            view.frame.origin = .zero
            self.renderHost = host
            self.webView = view
            view.loadHTMLString(self.request.document, baseURL: nil)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = !startedNavigation && navigationAction.targetFrame?.isMainFrame == true
            && navigationAction.request.url?.absoluteString == "about:blank"
        if allowed { startedNavigation = true }
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !stopped, !rendering else { return }
        guard webView.scrollView.contentSize.width <= CGFloat(request.width) + 1,
              webView.scrollView.contentSize.height <= CGFloat(request.height) + 1 else {
            fail("HTML layout exceeds declared snapshot dimensions"); return
        }
        rendering = true
        if request.pdf {
            var bounds = CGRect(origin: .zero, size: pageSize)
            pdfContext = CGContext(output as CFURL, mediaBox: &bounds, nil)
            guard pdfContext != nil else { fail("Could not create PDF output"); return }
            captureNextPDFPage()
        } else {
            bitmap = CGContext(data: nil, width: request.width, height: request.height, bitsPerComponent: 8,
                               bytesPerRow: request.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            guard let bitmap else { fail("Could not allocate image output"); return }
            bitmap.setFillColor(UIColor.white.cgColor)
            bitmap.fill(CGRect(x: 0, y: 0, width: request.width, height: request.height))
            captureNextTile()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("Snapshot navigation failed") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("Snapshot loading failed") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("Snapshot renderer terminated") }

    private func captureNextPDFPage() {
        guard !stopped, let webView, let context = pdfContext else { return }
        guard webView.window != nil else { fail("Renderer owner detached"); return }
        if y == request.height { encode(); return }
        let rows = min(pageHeight, request.height - y)
        let configuration = WKPDFConfiguration()
        // WKPDFConfiguration.h specifies *web page* coordinates, unlike
        // WKSnapshotConfiguration's viewport coordinates. Keep the viewport at
        // zero and request each page's absolute CSS rect, including offscreen y.
        // Simulator regressions verify both text and tail-page pixel positions.
        configuration.rect = CGRect(x: 0, y: y, width: request.width, height: rows)
        generatingPDF = true
        webView.createPDF(configuration: configuration) { [self] result in
            generatingPDF = false
            if stopped {
                completeCancellation()
                return
            }
            guard case .success(let data) = result,
                  let provider = CGDataProvider(data: data as CFData),
                  let document = CGPDFDocument(provider), document.numberOfPages == 1,
                  let page = document.page(at: 1) else {
                fail("Could not create native PDF page"); return
            }
            let sourceBounds = page.getBoxRect(.mediaBox)
            guard abs(sourceBounds.width - CGFloat(request.width)) < 1,
                  abs(sourceBounds.height - CGFloat(rows)) < 1 else {
                fail("Native PDF page dimensions do not match the requested region"); return
            }
            autoreleasepool {
                context.beginPDFPage(nil)
                context.saveGState()
                // Convert CSS 96px/in to PDF 72pt/in, shrinking further only
                // when necessary to fit the width inside the 24pt margins.
                context.translateBy(x: 24, y: pageSize.height - 24 - CGFloat(rows) * pdfScale)
                context.scaleBy(x: pdfScale, y: pdfScale)
                context.translateBy(x: -sourceBounds.minX, y: -sourceBounds.minY)
                // Drawing a CGPDFPage into another PDF context keeps vectors and
                // font/text operators. No UIImage or bitmap enters this path.
                context.drawPDFPage(page)
                context.restoreGState()
                context.endPDFPage()
            }
            y += rows
            progress("rendering", y, request.height)
            DispatchQueue.main.async { [weak self] in self?.captureNextPDFPage() }
        }
    }

    private func captureNextTile() {
        guard !stopped, let webView else { return }
        guard webView.window != nil else { fail("Renderer owner detached"); return }
        if y == request.height { encode(); return }
        let tileHeight = min(512, request.height - y)
        let scrollY = min(y, max(0, request.height - Int(webView.bounds.height)))
        webView.scrollView.setContentOffset(CGPoint(x: 0, y: scrollY), animated: false)
        webView.layoutIfNeeded()
        // WebKit commits a scroll asynchronously. Waiting for a compositor turn
        // and asking afterScreenUpdates avoids blank unpainted offscreen tiles.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak webView] in
            guard let self, !self.stopped, let webView else { return }
            let configuration = WKSnapshotConfiguration()
            configuration.rect = CGRect(x: 0, y: self.y - scrollY, width: self.request.width, height: tileHeight)
            configuration.snapshotWidth = NSNumber(value: Double(self.request.width) / Double(webView.window?.screen.scale ?? 1))
            configuration.afterScreenUpdates = true
            webView.takeSnapshot(with: configuration) { [weak self] image, error in
                guard let self, !self.stopped else { return }
                guard error == nil, let image = image?.cgImage else { self.fail("Could not capture snapshot tile"); return }
                autoreleasepool {
                    self.bitmap?.draw(image, in: CGRect(x: 0, y: self.request.height - self.y - tileHeight,
                                                      width: self.request.width, height: tileHeight))
                }
                self.y += tileHeight
                self.progress("rendering", self.y, self.request.height)
                self.captureNextTile()
            }
        }
    }

    private func encode() {
        progress("encoding", nil, nil)
        detachWebView()
        if let context = pdfContext {
            context.closePDF()
            pdfContext = nil
            finish(.success(output))
            return
        }
        guard let image = bitmap?.makeImage() else { fail("Could not assemble image"); return }
        bitmap = nil
        let output = output
        // Write directly to a native file, never through a JS/base64 buffer.
        encoding = true
        encoder.async { [self] in
            let success = autoreleasepool {
                guard let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
                CGImageDestinationAddImage(destination, image, nil)
                return CGImageDestinationFinalize(destination)
            }
            DispatchQueue.main.async {
                self.encoding = false
                if self.stopped {
                    try? FileManager.default.removeItem(at: output.deletingLastPathComponent())
                    self.completeCancellation()
                    return
                }
                if success { self.finish(.success(output)) } else { self.fail("Could not encode image") }
            }
        }
    }

    func cancel(completion: @escaping () -> Void = {}) {
        stopped = true
        self.completion = nil
        dispose()
        // Keep the owner's busy slot until in-flight native work drains, so
        // repeated cancel/retry cannot retain N canvases or PDF responses.
        if encoding || generatingPDF { cancellationCompleted = completion } else { completion() }
    }

    private func completeCancellation() {
        let completed = cancellationCompleted
        cancellationCompleted = nil
        completed?()
    }

    private func fail(_ message: String) {
        finish(.failure(YuriViewExportError(code: "EXPORT_RENDER_FAILED", message: message)))
    }

    private func finish(_ result: Result<URL, YuriViewExportError>) {
        guard !stopped else { return }
        stopped = true
        let callback = completion
        completion = nil
        dispose()
        callback?(result)
    }

    private func detachWebView() {
        webView?.navigationDelegate = nil
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
        renderHost?.removeFromSuperview()
        renderHost = nil
    }

    private func dispose() {
        timeout?.cancel()
        timeout = nil
        detachWebView()
        bitmap = nil
        pdfContext?.closePDF()
        pdfContext = nil
    }
}
