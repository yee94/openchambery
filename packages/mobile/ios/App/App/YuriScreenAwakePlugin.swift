import Capacitor
import UIKit

@objc(YuriScreenAwakePlugin)
class YuriScreenAwakePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "YuriScreenAwakePlugin"
    let jsName = "YuriScreenAwake"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise)
    ]
    private var enabled = false

    override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(updateIdleTimer(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(updateIdleTimer(_:)), name: UIApplication.willResignActiveNotification, object: nil)
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let value = call.getBool("enabled") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("Screen awake plugin unavailable"); return }
            self.enabled = value
            self.updateIdleTimer(nil)
            call.resolve()
        }
    }

    @objc private func updateIdleTimer(_ notification: Notification?) {
        let resigning = notification?.name == UIApplication.willResignActiveNotification
        UIApplication.shared.isIdleTimerDisabled = enabled && !resigning && UIApplication.shared.applicationState == .active
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
    }
}
