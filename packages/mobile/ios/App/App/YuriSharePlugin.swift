import Capacitor

@objc(YuriSharePlugin)
class YuriSharePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "YuriSharePlugin"
    let jsName = "YuriShare"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "updateCatalog", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "donateAssistantInteraction", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "listPending", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "releaseFiles", returnType: CAPPluginReturnPromise)]
    // Capacitor's getArray(_:type:) treats nested dictionaries poorly; cast via Any.
    @objc func updateCatalog(_ call: CAPPluginCall) {
        guard let raw = call.getArray("entries") else { call.reject("entries is required"); return }
        let entries = raw.compactMap { $0 as? [String: Any] }
        do { try YuriShareStore.updateCatalog(entries); call.resolve() } catch { call.reject(error.localizedDescription) }
    }
    @objc func donateAssistantInteraction(_ call: CAPPluginCall) {
        guard let serverInstanceID = call.getString("serverInstanceID"),
              let assistantID = call.getString("assistantID"),
              let name = call.getString("name") else { call.reject("assistant identity is required"); return }
        var target: [String: Any] = ["serverInstanceID": serverInstanceID, "assistantID": assistantID, "name": name, "avatarSeed": call.getString("avatarSeed") ?? assistantID]
        if let avatarPng = call.getString("avatarPng") { target["avatarPng"] = avatarPng }
        if let avatarEmoji = call.getString("avatarEmoji"), !avatarEmoji.isEmpty {
            target["avatarEmoji"] = avatarEmoji
        }
        YuriShareStore.donateAssistantInteraction(target: target) { error in
            DispatchQueue.main.async {
                if let error { call.reject(error.localizedDescription) } else { call.resolve() }
            }
        }
    }
    @objc func listPending(_ call: CAPPluginCall) { do { let data = try JSONEncoder().encode(try YuriShareStore.pending()); call.resolve(["envelopes": try JSONSerialization.jsonObject(with: data)]) } catch { call.reject(error.localizedDescription) } }
    @objc func ack(_ call: CAPPluginCall) { guard let operationID = call.getString("operationID") else { call.reject("operationID is required"); return }; do { try YuriShareStore.acknowledge(operationID); call.resolve() } catch { call.reject(error.localizedDescription) } }
    @objc func releaseFiles(_ call: CAPPluginCall) { guard let operationID = call.getString("operationID") else { call.reject("operationID is required"); return }; do { try YuriShareStore.release(operationID); call.resolve() } catch { call.reject(error.localizedDescription) } }
    func emitReceived(_ operationID: String) { notifyListeners("shareReceived", data: ["operationID": operationID]) }
}
