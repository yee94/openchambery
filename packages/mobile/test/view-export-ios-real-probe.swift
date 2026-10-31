import UIKit
import ImageIO
import PDFKit
import Vision
import WebKit

/// Opt-in fixture runner. The report stays outside the repository; only the
/// supplied snapshot is bundled, and generated evidence is copied out by Vitest.
@main
final class ViewExportRealProbe: UIResponder, UIApplicationDelegate, WKNavigationDelegate {
    var window: UIWindow?
    private var renderer: YuriViewExportRenderer?
    private var input: [String: Any] = [:]
    private var variant = 0
    private var evidence: [String: Any] = [:]
    private var rawPDFView: WKWebView?
    private let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let owner = UIViewController()
        owner.view.backgroundColor = .white
        let cover = UIView(frame: window.bounds)
        cover.backgroundColor = .white
        owner.view.addSubview(cover)
        window.rootViewController = owner
        window.makeKeyAndVisible()
        self.window = window
        do {
            input = try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.main.url(forResource: "snapshot", withExtension: "json")!)) as! [String: Any]
            let snapshot = input["snapshot"] as! [String: Any]
            evidence = ["width": snapshot["width"]!, "height": snapshot["height"]!,
                        "htmlBytes": (snapshot["html"] as! String).utf8.count,
                        "systemVersion": UIDevice.current.systemVersion,
                        "footerComparison": "NFKC + whitespace removal + CJK RADICAL C-SIMPLIFIED SEE (U+2EC5) to U+89C1; raw WebKit PDF/text retained"]
            DispatchQueue.main.async { self.runNext() }
        } catch { fail("fixture: \(error)") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 180) { self.fail("real fixture timeout") }
        return true
    }

    private func runNext() {
        do {
            input["filename"] = variant == 0 ? "eficy-report.png" : variant == 1 ? "eficy-report-a4.pdf" : "eficy-report-letter.pdf"
            if variant == 2 { input["pageSize"] = "letter" }
            let request = try YuriViewExportRequest(input, pdf: variant != 0)
            let started = Date()
            renderer = YuriViewExportRenderer(request: request, directory: directory, progress: { _, _, _ in }, completion: { result in
                switch result {
                case .failure(let error): self.fail("render: \(error)")
                case .success(let url):
                    do {
                        if self.variant == 0 { try self.checkPNG(url, request: request) }
                        else { try self.checkPDF(url) }
                        self.evidence[url.lastPathComponent + ".seconds"] = Date().timeIntervalSince(started)
                        self.evidence[url.lastPathComponent + ".bytes"] = (try Data(contentsOf: url)).count
                        self.renderer = nil
                        self.variant += 1
                        if self.variant == 1 { self.captureRawWebKitTail(); return }
                        if self.variant == 3 {
                            try JSONSerialization.data(withJSONObject: self.evidence, options: [.prettyPrinted, .sortedKeys])
                                .write(to: self.directory.appendingPathComponent("ios-evidence.json"))
                            print("VIEW_EXPORT_REAL_PASSED"); fflush(stdout); exit(0)
                        }
                        self.runNext()
                    } catch { self.fail("verification: \(error)") }
                }
            })
            renderer!.start(in: window!.rootViewController!.view)
        } catch { fail("input: \(error)") }
    }

    private func captureRawWebKitTail() {
        do {
            let request = try YuriViewExportRequest(input, pdf: true)
            let configuration = WKWebViewConfiguration()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            configuration.websiteDataStore = .nonPersistent()
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: request.width, height: 512), configuration: configuration)
            view.navigationDelegate = self
            window!.rootViewController!.view.insertSubview(view, at: 0)
            rawPDFView = view
            view.loadHTMLString(request.document, baseURL: nil)
        } catch { fail("raw PDF setup: \(error)") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let snapshot = input["snapshot"] as! [String: Any]
        let width = snapshot["width"] as! Int, height = snapshot["height"] as! Int
        let scale = min(0.75, (595.28 - 48) / Double(width))
        let rows = Int(floor((841.89 - 48) / scale))
        let top = ((height - 1) / rows) * rows
        let configuration = WKPDFConfiguration()
        configuration.rect = CGRect(x: 0, y: top, width: width, height: height - top)
        webView.createPDF(configuration: configuration) { result in
            do {
                let data = try result.get()
                try data.write(to: self.directory.appendingPathComponent("webkit-raw-tail.pdf"))
                let text = PDFDocument(data: data)?.string ?? ""
                try text.write(to: self.directory.appendingPathComponent("webkit-raw-tail.txt"), atomically: true, encoding: .utf8)
                self.evidence["rawWebKitTailText"] = text
                webView.removeFromSuperview()
                self.rawPDFView = nil
                self.runNext()
            } catch { self.fail("raw PDF capture: \(error)") }
        }
    }

    private func checkPNG(_ url: URL, request: YuriViewExportRequest) throws {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("PNG decode"); return }
        require(image.width == request.width * 2 && image.height == request.height * 2, "PNG 2x dimensions")
        let cropHeight = min(1200, image.height)
        let bottom = image.cropping(to: CGRect(x: 0, y: image.height - cropHeight, width: image.width, height: cropHeight))!
        try UIImage(cgImage: bottom).pngData()!.write(to: directory.appendingPathComponent("ios-bottom.png"))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let upscaled = UIGraphicsImageRenderer(size: CGSize(width: image.width * 3, height: cropHeight * 3), format: format).image { _ in
            UIImage(cgImage: bottom).draw(in: CGRect(x: 0, y: 0, width: image.width * 3, height: cropHeight * 3))
        }
        let ocr = VNRecognizeTextRequest()
        ocr.recognitionLevel = .accurate
        ocr.recognitionLanguages = ["zh-Hans", "en-US"]
        try VNImageRequestHandler(cgImage: upscaled.cgImage!).perform([ocr])
        let text = (ocr.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        try text.write(to: directory.appendingPathComponent("ios-bottom-ocr.txt"), atomically: true, encoding: .utf8)
        evidence["pngFooterOCR"] = text
        // The original 9.9 CSS-pixel footer now has 19.8 output pixels at 2x.
        // Keep the crop for visual inspection and use several stable OCR anchors;
        // the native PDF below separately checks the complete exact footer text.
        require(normalized(text).contains("口径") && text.contains("2026-10-28") && text.contains("ITERATION-REPORT.md"),
                "PNG bottom OCR missing footer anchors: \(text)")
    }

    private func checkPDF(_ url: URL) throws {
        guard let document = PDFDocument(url: url), document.pageCount > 1 else { fail("paginated PDF decode"); return }
        let tail = document.page(at: document.pageCount - 1)!
        let tailText = tail.string ?? ""
        let text = document.string ?? ""
        let expected = try String(contentsOf: Bundle.main.url(forResource: "expected-footer", withExtension: "txt")!, encoding: .utf8)
        try text.write(to: directory.appendingPathComponent(url.deletingPathExtension().lastPathComponent + "-text.txt"), atomically: true, encoding: .utf8)
        try tailText.write(to: directory.appendingPathComponent(url.deletingPathExtension().lastPathComponent + "-tail.txt"), atomically: true, encoding: .utf8)
        evidence[url.lastPathComponent + ".pages"] = document.pageCount
        evidence[url.lastPathComponent + ".tailText"] = tailText
        evidence[url.lastPathComponent + ".literalFooterFound"] = tailText.filter { !$0.isWhitespace }.contains(expected.filter { !$0.isWhitespace })
        evidence[url.lastPathComponent + ".normalizedFooterFound"] = normalized(tailText).contains(normalized(expected))
        evidence[url.lastPathComponent + ".searchDataKoujing"] = document.findString("数据口径", withOptions: []).count
        let englishMatches = document.findString("ITERATION-REPORT.md", withOptions: []).count
        let chineseMatches = document.findString("研究报告", withOptions: []).count
        evidence[url.lastPathComponent + ".searchEnglishMatches"] = englishMatches
        evidence[url.lastPathComponent + ".searchChineseMatches"] = chineseMatches
        require(englishMatches > 0 && chineseMatches > 0, "PDF text search failed")
        require(normalized(tailText).contains(normalized(expected)), "PDF last page does not contain complete searchable footer: \(tailText)")
        let size = variant == 1 ? CGSize(width: 595.28, height: 841.89) : CGSize(width: 612, height: 792)
        let snapshot = input["snapshot"] as! [String: Any]
        let cssWidth = snapshot["width"] as! Int, cssHeight = snapshot["height"] as! Int
        let scale = min(0.75, (size.width - 48) / CGFloat(cssWidth))
        let rows = Int(floor((size.height - 48) / scale))
        let expectedPages = (cssHeight + rows - 1) / rows
        evidence[url.lastPathComponent + ".cssToPointScale"] = scale
        evidence[url.lastPathComponent + ".expectedPages"] = expectedPages
        require(document.pageCount == expectedPages, "PDF page count does not match CSS 96px/in to 72pt/in scale")
        for index in 0..<document.pageCount {
            let bounds = document.page(at: index)!.bounds(for: .mediaBox)
            require(abs(bounds.width - size.width) < 0.1 && abs(bounds.height - size.height) < 0.1, "PDF paper size")
        }
        let preview = tail.thumbnail(of: CGSize(width: size.width * 2, height: size.height * 2), for: .mediaBox)
        try preview.pngData()!.write(to: directory.appendingPathComponent(url.deletingPathExtension().lastPathComponent + "-tail.png"))
        let width = Int(ceil(size.width)), height = Int(ceil(size.height))
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(UIColor.white.cgColor)
        context.fill(CGRect(origin: .zero, size: size))
        context.drawPDFPage(tail.pageRef!)
        let bytes = context.data!.assumingMemoryBound(to: UInt8.self)
        let pixel = (0..<3).map { Int(bytes[(40 * width + 30) * 4 + $0]) }
        evidence[url.lastPathComponent + ".leftContentPixel"] = pixel
        require(pixel.allSatisfy { $0 < 64 }, "phone PDF content did not start at its 24pt page margin")
        let contentRight = 24 + CGFloat(cssWidth) * scale
        let inside = (0..<3).map { Int(bytes[(40 * width + Int(contentRight) - 2) * 4 + $0]) }
        let outside = (0..<3).map { Int(bytes[(40 * width + Int(ceil(contentRight)) + 2) * 4 + $0]) }
        evidence[url.lastPathComponent + ".rightInsidePixel"] = inside
        evidence[url.lastPathComponent + ".rightOutsidePixel"] = outside
        require(inside.allSatisfy { $0 < 64 } && outside.allSatisfy { $0 > 250 }, "phone snapshot was enlarged beyond its 0.75 physical scale")
    }

    private func normalized(_ value: String) -> String {
        // Native WebKit's PingFang PDF maps shared glyphs to radical aliases.
        // NFKC handles Kangxi radicals but not this CJK Supplement alias. The
        // untouched raw PDF proves it predates our CoreGraphics pagination.
        value.precomposedStringWithCompatibilityMapping.replacingOccurrences(of: "\u{2EC5}", with: "见")
            .filter { !$0.isWhitespace }
    }
    private func require(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
    private func fail(_ message: String) { print("VIEW_EXPORT_REAL_FAILED: \(message)"); fflush(stdout); exit(1) }
}
