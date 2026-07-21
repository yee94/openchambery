import Capacitor

@objc(OpenChamberSharePlugin)
class OpenChamberSharePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberSharePlugin"
    let jsName = "OpenChamberShare"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "updateCatalog", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "listPending", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "releaseFiles", returnType: CAPPluginReturnPromise)]
    @objc func updateCatalog(_ call: CAPPluginCall) { guard let entries = call.getArray("entries", [[String: Any]].self) else { call.reject("entries is required"); return }; do { try OpenChamberShareStore.updateCatalog(entries); call.resolve() } catch { call.reject(error.localizedDescription) } }
    @objc func listPending(_ call: CAPPluginCall) { do { let data = try JSONEncoder().encode(try OpenChamberShareStore.pending()); call.resolve(["envelopes": try JSONSerialization.jsonObject(with: data)]) } catch { call.reject(error.localizedDescription) } }
    @objc func ack(_ call: CAPPluginCall) { guard let operationID = call.getString("operationID") else { call.reject("operationID is required"); return }; do { try OpenChamberShareStore.acknowledge(operationID); call.resolve() } catch { call.reject(error.localizedDescription) } }
    @objc func releaseFiles(_ call: CAPPluginCall) { guard let operationID = call.getString("operationID") else { call.reject("operationID is required"); return }; do { try OpenChamberShareStore.release(operationID); call.resolve() } catch { call.reject(error.localizedDescription) } }
    func emitReceived(_ operationID: String) { notifyListeners("shareReceived", data: ["operationID": operationID]) }
}
