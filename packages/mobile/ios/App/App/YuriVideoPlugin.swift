import Capacitor
import Foundation

@objc(YuriVideoPlugin)
final class YuriVideoPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "YuriVideoPlugin"
    let jsName = "YuriVideo"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise),
    ]
    private var servers: [String: YuriVideoServer] = [:]
    private var requests: [String: String] = [:]

    @objc func create(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let assetId = call.getString("assetId"), UUID(uuidString: assetId) != nil,
                  self.servers[assetId] == nil, self.servers.count < 2 else {
                call.reject("Invalid or excess video lease"); return
            }
            let server = YuriVideoServer(assetId: assetId) { [weak self] event in
                DispatchQueue.main.async {
                    guard let self, self.servers[assetId] != nil else { return }
                    if let requestId = event["requestId"] as? String {
                        if event["cancelled"] as? Bool == true { self.requests.removeValue(forKey: requestId) }
                        else { self.requests[requestId] = assetId }
                    }
                    self.notifyListeners("request", data: event)
                }
            }
            self.servers[assetId] = server
            server.start { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let url): call.resolve(["url": url])
                    case .failure(let error):
                        self.servers.removeValue(forKey: assetId)?.stop()
                        call.reject(error.localizedDescription)
                    }
                }
            }
        }
    }

    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let requestId = call.getString("requestId"), let assetId = self.requests.removeValue(forKey: requestId),
                  let server = self.servers[assetId] else { call.resolve(); return }
            let encoded = call.getString("dataBase64") ?? ""
            guard encoded.count <= (YuriVideoServer.maxRangeBytes + 2) / 3 * 4,
                  let data = Data(base64Encoded: encoded) else {
                server.respond(requestId: requestId, status: 502, contentType: nil, contentRange: nil, contentLength: 0, data: Data())
                call.reject("Invalid video range bytes"); return
            }
            server.respond(requestId: requestId, status: call.getInt("status") ?? 502,
                           contentType: call.getString("contentType"), contentRange: call.getString("contentRange"),
                           contentLength: call.getInt("contentLength"), data: data)
            call.resolve()
        }
    }

    @objc func release(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = call.getString("assetId") {
                self.servers.removeValue(forKey: id)?.stop()
                self.requests = self.requests.filter { $0.value != id }
            }
            call.resolve()
        }
    }

    deinit { for server in servers.values { server.stop() } }
}
