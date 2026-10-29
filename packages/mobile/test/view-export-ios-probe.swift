import UIKit
import ImageIO
import PDFKit
import Network

@main
final class ViewExportProbe: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var renderer: YuriViewExportRenderer?
    private var listener: NWListener?
    private var requests = 0
    private var outputDirectory: URL!
    private var progress: [String] = []
    private var variant = 0

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .magenta
        let cover = UIView(frame: window.bounds)
        cover.backgroundColor = .magenta
        controller.view.addSubview(cover)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        do {
            try validateInputs()
            listener = try NWListener(using: .tcp, on: .any)
            listener?.newConnectionHandler = { connection in
                self.requests += 1
                connection.cancel()
            }
            listener?.stateUpdateHandler = { state in
                if case .ready = state { self.runNext() }
            }
            listener?.start(queue: .main)
        } catch { fail("setup: \(error)") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { self.fail("probe timeout") }
        return true
    }

    private func input(html: String = "<div>snapshot</div>", width: Any = 1200, height: Any = 4300) -> [String: Any] {
        ["taskId": "probe-1", "snapshot": ["html": html, "width": width, "height": height], "filename": "snapshot.png"]
    }

    private func validateInputs() throws {
        func rejected(_ input: [String: Any], _ code: String, pdf: Bool = false) throws {
            do {
                _ = try YuriViewExportRequest(input, pdf: pdf)
                fail("accepted malformed input")
            } catch let error as YuriViewExportError {
                require(error.code == code, "wrong validation code: \(error.code)")
            }
        }
        try rejected(input(width: true), "EXPORT_INVALID_INPUT")
        try rejected(input(width: 1.5), "EXPORT_INVALID_INPUT")
        try rejected(input(width: Double.nan), "EXPORT_INVALID_INPUT")
        try rejected(input(height: 32769), "EXPORT_TOO_LARGE")
        try rejected(input(width: 2048, height: 4097), "EXPORT_TOO_LARGE")
        // A narrow snapshot keeps its physical scale instead of being enlarged
        // into thousands of pages by the page-width ratio.
        _ = try YuriViewExportRequest(input(width: 1, height: 32768), pdf: true)
        let htmlLimit = 100 * 1024 * 1024
        require(YuriViewExportRequest.limits["maxHTMLBytes"] == htmlLimit, "wrong HTML byte limit")
        let boundaryHTML = String(repeating: "界", count: htmlLimit / 3) + String(repeating: "a", count: htmlLimit % 3)
        require(boundaryHTML.utf8.count == htmlLimit && boundaryHTML.count < htmlLimit, "UTF-8 boundary fixture")
        for pdf in [false, true] {
            _ = try YuriViewExportRequest(input(html: boundaryHTML), pdf: pdf)
            try rejected(input(html: boundaryHTML + "a"), "EXPORT_TOO_LARGE", pdf: pdf)
        }
        try rejected(input(html: "<iframe srcdoc='unsafe'></iframe>"), "EXPORT_FORBIDDEN")
        try rejected(input(html: "<script>alert(1)</script>"), "EXPORT_FORBIDDEN")
        var bad = input()
        bad["filename"] = "../snapshot.png"
        try rejected(bad, "EXPORT_INVALID_INPUT")
        bad = input(); bad["pageSize"] = "legal"
        try rejected(bad, "EXPORT_INVALID_INPUT", pdf: true)
        _ = try YuriViewExportRequest(input(width: 2048, height: 4096), pdf: false)
        print("INPUT_VALIDATION_PASSED")
    }

    private func runNext() {
        if variant == 3 { checkCancellation(); return }
        let port = listener!.port!.rawValue
        let html = """
        <div style="position:relative;width:1200px;height:4300px;background:white">
        <div style="position:absolute;top:0;width:1200px;height:1100px;background:rgb(255,0,0)"></div>
        <div style="position:absolute;top:1100px;width:1200px;height:2100px;background:rgb(0,255,0)"></div>
        <div style="position:absolute;top:3200px;width:1200px;height:1100px;background:rgb(0,0,255)"></div>
        <div style="position:absolute;left:1100px;top:0;width:100px;height:4300px;background:rgb(255,255,0)"></div>
        <p style="position:absolute;left:30px;top:100px;font:24px sans-serif">SEARCHABLE_FIRST_PAGE</p>
        <p style="position:absolute;left:30px;top:2000px;font:24px sans-serif">SEARCHABLE_MIDDLE_PAGE</p>
        <p style="position:absolute;left:30px;top:4200px;font:24px sans-serif">SEARCHABLE_LAST_PAGE 数据口径</p>
        <img src="http://127.0.0.1:\(port)/forbidden" onerror="document.body.innerHTML='script executed'" style="position:absolute;top:0;left:0;width:1px;height:1px">
        </div>
        """
        do {
            var options = input(html: html)
            if variant == 2 { options["pageSize"] = "letter" }
            let request = try YuriViewExportRequest(options, pdf: variant != 0)
            outputDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: false)
            progress = []
            renderer = YuriViewExportRenderer(request: request, directory: outputDirectory, progress: { stage, completed, total in
                self.progress.append(stage)
                if stage == "rendering" { self.require(completed! <= total! && total == 4300, "bad progress") }
            }, completion: { result in
                switch result {
                case .failure(let error): self.fail("render: \(error)")
                case .success(let url):
                    self.checkOutput(url)
                    self.require(self.progress.first == "preparing" && self.progress.last == "encoding", "progress stages")
                    self.require(self.requests == 0, "network escaped sandbox")
                    self.require(self.window!.rootViewController!.view.subviews.count == 1, "renderer leaked view")
                    try? FileManager.default.removeItem(at: self.outputDirectory)
                    self.renderer = nil
                    self.variant += 1
                    self.runNext()
                }
            })
            renderer!.start(in: window!.rootViewController!.view)
        } catch { fail("request: \(error)") }
    }

    private func checkOutput(_ url: URL) {
        if variant == 0 {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("PNG decode"); return }
            require(image.width == 1200 && image.height == 4300, "PNG must be 1 CSS pixel = 1 pixel")
            for (y, expected) in [(10, [255,0,0]), (600, [255,0,0]), (1700, [0,255,0]), (3201, [0,0,255]), (4299, [0,0,255])] {
                checkPixel(image, x: 600, y: y, expected: expected)
                checkPixel(image, x: 1199, y: y, expected: [255,255,0])
            }
            print("LONG_IMAGE_PIXELS_PASSED")
        } else {
            guard let document = CGPDFDocument(url as CFURL) else { fail("PDF decode"); return }
            require(document.numberOfPages == 3, "paginated PDF page count \(document.numberOfPages)")
            guard let searchable = PDFDocument(url: url) else { fail("PDFKit decode"); return }
            for (index, text) in ["SEARCHABLE_FIRST_PAGE", "SEARCHABLE_MIDDLE_PAGE", "SEARCHABLE_LAST_PAGE"].enumerated() {
                require(searchable.page(at: index)?.string?.contains(text) == true, "missing searchable page text: \(text)")
            }
            let tailText = (searchable.page(at: 2)?.string ?? "").precomposedStringWithCompatibilityMapping.filter { !$0.isWhitespace }
            require(tailText.contains("数据口径"), "missing searchable Chinese footer: \(tailText)")
            let expected = variant == 1 ? CGSize(width: 595.28, height: 841.89) : CGSize(width: 612, height: 792)
            for number in 1...document.numberOfPages {
                let page = document.page(at: number)!
                let bounds = page.getBoxRect(.mediaBox)
                require(abs(bounds.width - expected.width) < 0.1 && abs(bounds.height - expected.height) < 0.1, "PDF page size")
                let context = CGContext(data: nil, width: Int(ceil(bounds.width)), height: Int(ceil(bounds.height)), bitsPerComponent: 8,
                                        bytesPerRow: Int(ceil(bounds.width)) * 4, space: CGColorSpaceCreateDeviceRGB(),
                                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.drawPDFPage(page)
                let image = context.makeImage()!
                checkPixel(image, x: 100, y: 60, expected: number == 1 ? [255,0,0] : number == 2 ? [0,255,0] : [0,0,255])
            }
            print(variant == 1 ? "A4_PAGINATION_PASSED" : "LETTER_PAGINATION_PASSED")
            print("PDF_SEARCHABLE_TAIL_PASSED")
        }
    }

    private func checkPixel(_ image: CGImage, x: Int, y: Int, expected: [Int]) {
        let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                                bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let bytes = context.data!.assumingMemoryBound(to: UInt8.self)
        let offset = (y * image.width + x) * 4
        for channel in 0..<3 {
            require(abs(Int(bytes[offset + channel]) - expected[channel]) <= 3, "pixel \(x),\(y) channel \(channel): \(bytes[offset + channel]) != \(expected[channel])")
        }
    }

    private func checkCancellation() {
        do {
            let request = try YuriViewExportRequest(input(), pdf: false)
            outputDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: false)
            renderer = YuriViewExportRenderer(request: request, directory: outputDirectory, progress: { _, _, _ in }, completion: { _ in self.fail("cancelled renderer completed") })
            renderer!.start(in: window!.rootViewController!.view)
            renderer!.cancel()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.require(self.window!.rootViewController!.view.subviews.count == 1, "cancel leaked view")
                try? FileManager.default.removeItem(at: self.outputDirectory)
                self.listener?.cancel()
                print("VIEW_EXPORT_IOS_PASSED"); fflush(stdout); exit(0)
            }
        } catch { fail("cancel setup") }
    }

    private func require(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
    private func fail(_ message: String) {
        print("VIEW_EXPORT_IOS_FAILED: \(message)"); fflush(stdout); exit(1)
    }
}
