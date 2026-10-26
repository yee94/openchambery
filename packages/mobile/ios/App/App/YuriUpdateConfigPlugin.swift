import Capacitor
import Foundation

@objc(YuriUpdateConfigPlugin)
class YuriUpdateConfigPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "YuriUpdateConfigPlugin"
    let jsName = "YuriUpdateConfig"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getConfiguration", returnType: CAPPluginReturnPromise)
    ]

    @objc func getConfiguration(_ call: CAPPluginCall) {
        // The main bundle is immutable across Capgo web updates.
        guard let url = Bundle.main.url(forResource: "capacitor.config", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let config = root["YuriOTA"] as? [String: Any],
              let channel = config["channel"] as? String,
              let shellApiVersion = config["shellApiVersion"] as? Int else {
            call.reject("Native update configuration unavailable")
            return
        }
        call.resolve(["channel": channel, "shellApiVersion": shellApiVersion])
    }
}
