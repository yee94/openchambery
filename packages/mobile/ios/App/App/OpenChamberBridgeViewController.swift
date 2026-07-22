import Capacitor

class OpenChamberBridgeViewController: CAPBridgeViewController {
    // Keep a strong ref so share-extension deep links can emit without looking the
    // plugin up via CAPBridgeProtocol (Capacitor 8 no longer exposes getPlugin(_:)).
    private var sharePlugin: OpenChamberSharePlugin?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenChamberHapticsPlugin())
        let sharePlugin = OpenChamberSharePlugin()
        self.sharePlugin = sharePlugin
        bridge?.registerPluginInstance(sharePlugin)
        NotificationCenter.default.addObserver(forName: .openChamberShareReceived, object: nil, queue: .main) { [weak self] notification in
            guard let operationID = notification.object as? String else { return }
            self?.sharePlugin?.emitReceived(operationID)
        }
    }
}
