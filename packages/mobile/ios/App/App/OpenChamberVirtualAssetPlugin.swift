import Capacitor
import Foundation

@objc(OpenChamberVirtualAssetPlugin)
class OpenChamberVirtualAssetPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberVirtualAssetPlugin"
    let jsName = "OpenChamberVirtualAsset"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private let bridgeQueue = DispatchQueue(label: "com.openchamber.virtual-asset.plugin", qos: .userInitiated)

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
                let url = try OpenChamberVirtualAssetStore.create(assetId: assetId, mime: mime)
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
                try OpenChamberVirtualAssetStore.append(assetId: assetId, base64: chunk)
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
                try OpenChamberVirtualAssetStore.finish(assetId: assetId)
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
                try OpenChamberVirtualAssetStore.cancel(assetId: assetId)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
