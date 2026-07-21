import Capacitor

class OpenChamberBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(OpenChamberHapticsPlugin())
        bridge?.registerPluginInstance(OpenChamberSharePlugin())
        NotificationCenter.default.addObserver(forName: .openChamberShareReceived, object: nil, queue: .main) { [weak self] notification in
            guard let operationID = notification.object as? String else { return }
            (self?.bridge?.getPlugin("OpenChamberShare")?.instance as? OpenChamberSharePlugin)?.emitReceived(operationID)
        }
    }
}
