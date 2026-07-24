import Capacitor
import UIKit

@objc(OpenChamberNavigationPlugin)
class OpenChamberNavigationPlugin: CAPPlugin, CAPBridgedPlugin, UIGestureRecognizerDelegate {
    let identifier = "OpenChamberNavigationPlugin"
    let jsName = "OpenChamberNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise)
    ]

    private var edgePan: UIScreenEdgePanGestureRecognizer?
    private var navigationEnabled = false

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let hostView = self.bridge?.viewController?.view else { return }
            let edgePan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(self.handleEdgePan(_:)))
            edgePan.edges = .left
            edgePan.delegate = self
            edgePan.cancelsTouchesInView = true
            edgePan.isEnabled = false
            hostView.addGestureRecognizer(edgePan)
            self.edgePan = edgePan
        }
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async { [weak self] in
            self?.navigationEnabled = enabled
            self?.edgePan?.isEnabled = enabled
            call.resolve()
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard navigationEnabled, let edgePan = gestureRecognizer as? UIScreenEdgePanGestureRecognizer else {
            return false
        }
        let velocity = edgePan.velocity(in: edgePan.view)
        return velocity.x > 0 && abs(velocity.x) > abs(velocity.y)
    }

    @objc private func handleEdgePan(_ recognizer: UIScreenEdgePanGestureRecognizer) {
        guard navigationEnabled, let view = recognizer.view else { return }
        let width = max(view.bounds.width, 1)
        let progress = min(1, max(0, recognizer.translation(in: view).x / width))

        switch recognizer.state {
        case .began:
            notifyListeners("backStarted", data: ["progress": progress])
        case .changed:
            notifyListeners("backProgressed", data: ["progress": progress])
        case .ended:
            let velocity = recognizer.velocity(in: view).x
            let commit = progress >= 0.35 || (progress >= 0.08 && velocity >= 700)
            notifyListeners(commit ? "backInvoked" : "backCancelled", data: ["progress": progress])
        case .cancelled, .failed:
            notifyListeners("backCancelled", data: ["progress": progress])
        default:
            break
        }
    }
}

class OpenChamberBridgeViewController: CAPBridgeViewController {
    // Keep a strong ref so share-extension deep links can emit without looking the
    // plugin up via CAPBridgeProtocol (Capacitor 8 no longer exposes getPlugin(_:)).
    private var sharePlugin: OpenChamberSharePlugin?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenChamberHapticsPlugin())
        bridge?.registerPluginInstance(OpenChamberNavigationPlugin())
        let sharePlugin = OpenChamberSharePlugin()
        self.sharePlugin = sharePlugin
        bridge?.registerPluginInstance(sharePlugin)
        NotificationCenter.default.addObserver(forName: .openChamberShareReceived, object: nil, queue: .main) { [weak self] notification in
            guard let operationID = notification.object as? String else { return }
            self?.sharePlugin?.emitReceived(operationID)
        }
    }
}
