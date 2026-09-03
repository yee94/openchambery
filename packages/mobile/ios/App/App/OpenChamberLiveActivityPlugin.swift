import Capacitor
import Foundation

/// isSupported / start / update / end are runtime-gated at iOS 17.0 (OpenChamberWidget deployment).
/// The App target stays at 15.5; ActivityKit work is behind canImport + @available.
@objc(OpenChamberLiveActivityPlugin)
class OpenChamberLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberLiveActivityPlugin"
    let jsName = "OpenChamberLiveActivity"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    override func load() {
        OpenChamberLiveActivityManager.setPushTokenListener { [weak self] activityId, sessionId, token in
            self?.notifyListeners("pushToken", data: [
                "activityId": activityId,
                "sessionId": sessionId,
                "token": token,
            ])
        }
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": OpenChamberLiveActivityManager.isSupported()])
    }

    @objc func start(_ call: CAPPluginCall) {
        let request: OpenChamberLiveActivityRequest
        do {
            request = try parseRequest(call, requireStartedAt: true)
        } catch {
            call.reject(error.localizedDescription)
            return
        }
        Task { @MainActor in
            do {
                if let activityId = try await OpenChamberLiveActivityManager.start(request) {
                    call.resolve(["activityId": activityId])
                } else {
                    call.resolve([:])
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        let request: OpenChamberLiveActivityRequest
        do {
            request = try parseRequest(call, requireStartedAt: false)
        } catch {
            call.reject(error.localizedDescription)
            return
        }
        Task { @MainActor in
            do {
                try await OpenChamberLiveActivityManager.update(request)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        let request: OpenChamberLiveActivityRequest
        do {
            request = try parseRequest(call, requireStartedAt: false)
        } catch {
            call.reject(error.localizedDescription)
            return
        }
        Task { @MainActor in
            do {
                try await OpenChamberLiveActivityManager.end(request)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    private func parseRequest(
        _ call: CAPPluginCall,
        requireStartedAt: Bool
    ) throws -> OpenChamberLiveActivityRequest {
        guard let sessionId = call.getString("sessionId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty else {
            throw OpenChamberLiveActivityError.sessionIdRequired
        }
        guard let status = call.getString("status")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !status.isEmpty else {
            throw OpenChamberLiveActivityError.statusInvalid
        }
        guard let eventVersion = Self.intValue(call, "eventVersion") else {
            throw OpenChamberLiveActivityError.eventVersionRequired
        }
        guard let updatedAt = Self.doubleValue(call, "updatedAt") else {
            throw OpenChamberLiveActivityError.updatedAtRequired
        }
        let startedAt = Self.doubleValue(call, "startedAt")
        if requireStartedAt && startedAt == nil {
            throw OpenChamberLiveActivityError.startedAtRequired
        }
        let request = OpenChamberLiveActivityRequest(
            sessionId: sessionId,
            startedAt: startedAt,
            status: status,
            eventVersion: eventVersion,
            updatedAt: updatedAt,
            endedAt: Self.doubleValue(call, "endedAt"),
            dismissalSeconds: Self.doubleValue(call, "dismissalSeconds")
        )
        try request.validate(requireStartedAt: requireStartedAt)
        return request
    }

    private static func intValue(_ call: CAPPluginCall, _ key: String) -> Int? {
        // Prefer Double so millisecond eventVersion values survive JSON number decoding.
        if let value = call.getDouble(key), value.isFinite {
            return Int(value)
        }
        if let value = call.getInt(key) {
            return value
        }
        return nil
    }

    private static func doubleValue(_ call: CAPPluginCall, _ key: String) -> Double? {
        if let value = call.getDouble(key), value.isFinite {
            return value
        }
        if let value = call.getInt(key) {
            return Double(value)
        }
        return nil
    }
}
