import Capacitor
import UIKit
import WebKit

@objc(OpenChamberNavigationPlugin)
class OpenChamberNavigationPlugin: CAPPlugin, CAPBridgedPlugin, UIGestureRecognizerDelegate {
    let identifier = "OpenChamberNavigationPlugin"
    let jsName = "OpenChamberNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise)
    ]

    private var edgePan: UIScreenEdgePanGestureRecognizer?
    private var navigationEnabled = false
    private var progressDisplayLink: CADisplayLink?
    private var latestProgress: CGFloat = 0
    private var progressPending = false

    override func load() {
        DispatchQueue.main.async { [weak self] in
            _ = self?.installEdgePanIfNeeded()
        }
    }

    /// Install the left-edge pan recognizer on the web view (preferred) or bridge host view.
    /// Must run on the main thread. Returns false when no suitable host view is available.
    @discardableResult
    private func installEdgePanIfNeeded() -> Bool {
        if edgePan != nil { return true }
        let hostView = webView ?? bridge?.viewController?.view
        guard let hostView else { return false }
        let recognizer = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgePan(_:)))
        recognizer.edges = .left
        recognizer.delegate = self
        recognizer.cancelsTouchesInView = true
        recognizer.isEnabled = navigationEnabled
        hostView.addGestureRecognizer(recognizer)
        edgePan = recognizer
        return true
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("OpenChamberNavigation plugin deallocated")
                return
            }
            self.navigationEnabled = enabled
            guard self.installEdgePanIfNeeded() else {
                call.reject("OpenChamberNavigation edge pan host view unavailable")
                return
            }
            self.edgePan?.isEnabled = enabled
            if !enabled {
                self.stopProgressDisplayLink()
            }
            call.resolve()
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard navigationEnabled, gestureRecognizer === edgePan else {
            return false
        }
        return gestureRecognizer is UIScreenEdgePanGestureRecognizer
    }

    @objc private func handleEdgePan(_ recognizer: UIScreenEdgePanGestureRecognizer) {
        guard navigationEnabled, let view = recognizer.view else { return }
        let width = max(view.bounds.width, 1)
        let progress = min(1, max(0, recognizer.translation(in: view).x / width))

        switch recognizer.state {
        case .began:
            latestProgress = progress
            progressPending = false
            startProgressDisplayLink()
            notifyListeners("backStarted", data: ["progress": progress])
        case .changed:
            // UIKit can deliver touch samples faster than the WebView can
            // present frames. Keep only the newest value and cross the
            // Capacitor bridge once per display tick.
            latestProgress = progress
            progressPending = true
        case .ended:
            stopProgressDisplayLink()
            let velocity = recognizer.velocity(in: view).x
            let commit = progress >= 0.35 || (progress >= 0.08 && velocity >= 700)
            notifyListeners(commit ? "backInvoked" : "backCancelled", data: [
                "progress": progress,
                "velocityX": velocity
            ])
        case .cancelled, .failed:
            stopProgressDisplayLink()
            notifyListeners("backCancelled", data: [
                "progress": progress,
                "velocityX": recognizer.velocity(in: view).x
            ])
        default:
            break
        }
    }

    private func startProgressDisplayLink() {
        guard progressDisplayLink == nil else { return }
        let displayLink = CADisplayLink(target: self, selector: #selector(flushProgress))
        let maximumFramesPerSecond = UIScreen.main.maximumFramesPerSecond
        if #available(iOS 15.0, *) {
            displayLink.preferredFrameRateRange = CAFrameRateRange(
                minimum: Float(max(30, maximumFramesPerSecond / 2)),
                maximum: Float(maximumFramesPerSecond),
                preferred: Float(maximumFramesPerSecond)
            )
        } else {
            displayLink.preferredFramesPerSecond = maximumFramesPerSecond
        }
        displayLink.add(to: .main, forMode: .common)
        progressDisplayLink = displayLink
    }

    private func stopProgressDisplayLink() {
        progressDisplayLink?.invalidate()
        progressDisplayLink = nil
        progressPending = false
    }

    @objc private func flushProgress() {
        guard navigationEnabled, progressPending else { return }
        progressPending = false
        notifyListeners("backProgressed", data: ["progress": latestProgress])
    }
}

class OpenChamberBridgeViewController: CAPBridgeViewController {
    // Keep a strong ref so share-extension deep links can emit without looking the
    // plugin up via CAPBridgeProtocol (Capacitor 8 no longer exposes getPlugin(_:)).
    private var sharePlugin: OpenChamberSharePlugin?
    /// Retained so the WKWebView configuration keeps a live scheme handler.
    private let virtualAssetHandler = OpenChamberVirtualAssetHandler()

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // Opaque progressive image URLs: openchamber-asset://v/{assetId}
        // Must not collide with Capacitor's local scheme (capacitor / ionic / https).
        configuration.setURLSchemeHandler(virtualAssetHandler, forURLScheme: OpenChamberVirtualAssetStore.scheme)
        return configuration
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenChamberHapticsPlugin())
        bridge?.registerPluginInstance(OpenChamberNavigationPlugin())
        bridge?.registerPluginInstance(OpenChamberVirtualAssetPlugin())
        bridge?.registerPluginInstance(OpenChamberMediaPlugin())
        bridge?.registerPluginInstance(OpenChamberPhysicalScalePlugin())
        bridge?.registerPluginInstance(OpenChamberComposerPlugin())
        bridge?.registerPluginInstance(OpenChamberTabBarPlugin())
        bridge?.registerPluginInstance(OpenChamberLiveActivityPlugin())
        let sharePlugin = OpenChamberSharePlugin()
        self.sharePlugin = sharePlugin
        bridge?.registerPluginInstance(sharePlugin)
        NotificationCenter.default.addObserver(forName: .openChamberShareReceived, object: nil, queue: .main) { [weak self] notification in
            guard let operationID = notification.object as? String else { return }
            self?.sharePlugin?.emitReceived(operationID)
        }
    }
}
