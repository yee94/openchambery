import Capacitor
import Foundation

@objc(YuriVirtualAssetPlugin)
class YuriVirtualAssetPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "YuriVirtualAssetPlugin"
    let jsName = "YuriVirtualAsset"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private let bridgeQueue = DispatchQueue(label: "com.yuri.virtual-asset.plugin", qos: .userInitiated)

    @objc func create(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId") else {
            call.reject("assetId is required")
            return
        }
        guard let mime = call.getString("mime") else {
            call.reject("mime is required")
            return
        }
        bridgeQueue.async {
            do {
                let url = try YuriVirtualAssetStore.create(assetId: assetId, mime: mime)
                call.resolve(["assetId": assetId, "url": url])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func append(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId") else {
            call.reject("assetId is required")
            return
        }
        guard let chunk = call.getString("chunk") else {
            call.reject("chunk is required")
            return
        }
        // Append may block briefly for backpressure; keep off the Capacitor bridge thread.
        bridgeQueue.async {
            do {
                try YuriVirtualAssetStore.append(assetId: assetId, base64: chunk)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId") else {
            call.reject("assetId is required")
            return
        }
        bridgeQueue.async {
            do {
                try YuriVirtualAssetStore.finish(assetId: assetId)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId") else {
            call.reject("assetId is required")
            return
        }
        bridgeQueue.async {
            do {
                try YuriVirtualAssetStore.cancel(assetId: assetId)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
