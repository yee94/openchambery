import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

enum OpenChamberLiveActivityError: LocalizedError {
    case sessionIdRequired
    case startedAtRequired
    case statusInvalid
    case eventVersionRequired
    case updatedAtRequired
    case unsupported
    case disabled
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .sessionIdRequired:
            return "sessionId is required"
        case .startedAtRequired:
            return "startedAt is required"
        case .statusInvalid:
            return "status is invalid"
        case .eventVersionRequired:
            return "eventVersion is required"
        case .updatedAtRequired:
            return "updatedAt is required"
        case .unsupported:
            return "Live Activities are not supported"
        case .disabled:
            return "Live Activities are disabled"
        case .requestFailed(let message):
            return message
        }
    }
}

struct OpenChamberLiveActivityItem {
    let sessionId: String
    let title: String
    let status: String
    let startedAt: Double
    let endedAt: Double?
}

struct OpenChamberLiveActivityRequest {
    let sessionId: String
    let startedAt: Double?
    let status: String
    let eventVersion: Int
    let updatedAt: Double
    let endedAt: Double?
    let dismissalSeconds: Double?
    let title: String?
    let workingCount: Int?
    let items: [OpenChamberLiveActivityItem]?

    static let allowedStatuses: Set<String> = [
        "working", "tool", "retry", "input", "permission", "stale", "complete", "error",
    ]

    func validate(requireStartedAt: Bool) throws {
        if sessionId.isEmpty {
            throw OpenChamberLiveActivityError.sessionIdRequired
        }
        if requireStartedAt {
            guard let startedAt, startedAt.isFinite else {
                throw OpenChamberLiveActivityError.startedAtRequired
            }
        }
        if !Self.allowedStatuses.contains(status) {
            throw OpenChamberLiveActivityError.statusInvalid
        }
        guard updatedAt.isFinite else {
            throw OpenChamberLiveActivityError.updatedAtRequired
        }
        if let endedAt, !endedAt.isFinite {
            throw OpenChamberLiveActivityError.updatedAtRequired
        }
    }
}

enum OpenChamberLiveActivityManager {
    static let staleInterval: TimeInterval = 20 * 60
    static let successDismissal: TimeInterval = 15 * 60
    static let errorDismissal: TimeInterval = 60 * 60

    typealias PushTokenListener = (_ activityId: String, _ sessionId: String, _ token: String) -> Void

    /// Process-scoped: a user-dismissed Activity is not rebuilt for the same task.
    private static var dismissedSessionIDs = Set<String>()
    private static var trackedSessionIDs = Set<String>()
    private static var pushTokenTasks: [String: Task<Void, Never>] = [:]
    private static var pushTokenListener: PushTokenListener?

    static func setPushTokenListener(_ listener: PushTokenListener?) {
        pushTokenListener = listener
    }

    /// Millisecond timestamps (e.g. 1_700_000_000_000) must replace a recovered small counter.
    static func shouldApply(eventVersion: Int, onto current: Int) -> Bool {
        eventVersion > current
    }

    static func isSupported() -> Bool {
        #if canImport(ActivityKit) && os(iOS)
        if #available(iOS 17.0, *) {
            return ActivityAuthorizationInfo().areActivitiesEnabled
        }
        #endif
        return false
    }

    static func start(_ request: OpenChamberLiveActivityRequest) async throws -> String? {
        try request.validate(requireStartedAt: true)
        try Self.requireRuntimeSupport()
        #if canImport(ActivityKit) && os(iOS)
        if #available(iOS 17.0, *) {
            return try await startAvailable(request)
        }
        #endif
        throw OpenChamberLiveActivityError.unsupported
    }

    static func update(_ request: OpenChamberLiveActivityRequest) async throws {
        try request.validate(requireStartedAt: false)
        try Self.requireOSSupport()
        #if canImport(ActivityKit) && os(iOS)
        if #available(iOS 17.0, *) {
            await updateAvailable(request)
            return
        }
        #endif
        throw OpenChamberLiveActivityError.unsupported
    }

    static func end(_ request: OpenChamberLiveActivityRequest) async throws {
        try request.validate(requireStartedAt: false)
        try Self.requireOSSupport()
        #if canImport(ActivityKit) && os(iOS)
        if #available(iOS 17.0, *) {
            await endAvailable(request)
            return
        }
        #endif
        throw OpenChamberLiveActivityError.unsupported
    }

    private static func requireOSSupport() throws {
        #if canImport(ActivityKit) && os(iOS)
        if #available(iOS 17.0, *) {
            return
        }
        #endif
        throw OpenChamberLiveActivityError.unsupported
    }

    private static func requireRuntimeSupport() throws {
        try requireOSSupport()
        #if canImport(ActivityKit) && os(iOS)
        if #available(iOS 17.0, *) {
            if ActivityAuthorizationInfo().areActivitiesEnabled {
                return
            }
            throw OpenChamberLiveActivityError.disabled
        }
        #endif
        throw OpenChamberLiveActivityError.unsupported
    }

    private static func track(_ sessionId: String) {
        trackedSessionIDs.insert(sessionId)
        dismissedSessionIDs.remove(sessionId)
    }

    private static func markDismissed(_ sessionId: String) {
        dismissedSessionIDs.insert(sessionId)
        trackedSessionIDs.remove(sessionId)
    }

    private static func clearTask(for sessionId: String) {
        dismissedSessionIDs.remove(sessionId)
        trackedSessionIDs.remove(sessionId)
    }
}

#if canImport(ActivityKit) && os(iOS)
@available(iOS 17.0, *)
private extension OpenChamberLiveActivityManager {
    static func startAvailable(_ request: OpenChamberLiveActivityRequest) async throws -> String? {
        let activities = Activity<OpenChamberActivityAttributes>.activities
        var reusable: [Activity<OpenChamberActivityAttributes>] = []

        for activity in activities {
            switch activity.activityState {
            case .active, .stale:
                reusable.append(activity)
            case .ended, .dismissed:
                await endImmediately(activity)
                clearTask(for: activity.attributes.sessionID)
            @unknown default:
                await endImmediately(activity)
                clearTask(for: activity.attributes.sessionID)
            }
        }
        for extra in reusable.dropFirst() {
            await endImmediately(extra)
            clearTask(for: extra.attributes.sessionID)
        }

        if let existing = reusable.first {
            if shouldApply(eventVersion: request.eventVersion, onto: existing.content.state.eventVersion) {
                await existing.update(makeContent(request))
            }
            track(request.sessionId)
            ensurePushTokenUpdates(for: existing)
            return existing.id
        }

        if dismissedSessionIDs.contains(request.sessionId) || trackedSessionIDs.contains(request.sessionId) {
            markDismissed(request.sessionId)
            return nil
        }

        do {
            let attributes = OpenChamberActivityAttributes(
                sessionID: request.sessionId,
                startedAt: request.startedAt ?? 0
            )
            let activity = try Activity.request(
                attributes: attributes,
                content: makeContent(request),
                pushType: .token
            )
            track(request.sessionId)
            ensurePushTokenUpdates(for: activity)
            return activity.id
        } catch {
            throw OpenChamberLiveActivityError.requestFailed(error.localizedDescription)
        }
    }

    static func matchingActivities(sessionId: String) -> [Activity<OpenChamberActivityAttributes>] {
        let activities = Activity<OpenChamberActivityAttributes>.activities
        let exact = activities.filter { $0.attributes.sessionID == sessionId }
        return exact.isEmpty ? activities : exact
    }

    static func updateAvailable(_ request: OpenChamberLiveActivityRequest) async {
        let matching = matchingActivities(sessionId: request.sessionId)
        guard let existing = matching.first else {
            if trackedSessionIDs.contains(request.sessionId) {
                markDismissed(request.sessionId)
            }
            return
        }
        for extra in matching.dropFirst() {
            await endImmediately(extra)
        }
        ensurePushTokenUpdates(for: existing)
        guard shouldApply(eventVersion: request.eventVersion, onto: existing.content.state.eventVersion) else {
            return
        }
        await existing.update(makeContent(request))
        track(request.sessionId)
    }

    static func endAvailable(_ request: OpenChamberLiveActivityRequest) async {
        let matching = matchingActivities(sessionId: request.sessionId)
        guard let existing = matching.first else {
            clearTask(for: request.sessionId)
            return
        }
        for extra in matching.dropFirst() {
            await endImmediately(extra)
        }
        guard shouldApply(eventVersion: request.eventVersion, onto: existing.content.state.eventVersion) else {
            return
        }
        cancelPushTokenTask(for: existing.id)
        await existing.end(makeContent(request), dismissalPolicy: dismissalPolicy(for: request))
        clearTask(for: request.sessionId)
    }

    static func makeContent(
        _ request: OpenChamberLiveActivityRequest
    ) -> ActivityContent<OpenChamberActivityAttributes.ContentState> {
        let items = request.items?.map { item in
            OpenChamberActivityAttributes.SessionItem(
                sessionID: item.sessionId,
                title: item.title,
                status: item.status,
                startedAt: item.startedAt,
                endedAt: item.endedAt
            )
        }
        let state = OpenChamberActivityAttributes.ContentState(
            status: request.status,
            eventVersion: request.eventVersion,
            updatedAt: request.updatedAt,
            endedAt: request.endedAt,
            title: request.title,
            workingCount: request.workingCount,
            items: items
        )
        let staleDate = Date(timeIntervalSince1970: request.updatedAt + staleInterval)
        return ActivityContent(state: state, staleDate: staleDate)
    }

    static func dismissalPolicy(
        for request: OpenChamberLiveActivityRequest
    ) -> ActivityUIDismissalPolicy {
        if let dismissalSeconds = request.dismissalSeconds {
            if dismissalSeconds <= 0 {
                return .immediate
            }
            return .after(Date().addingTimeInterval(dismissalSeconds))
        }
        if request.status == "error" {
            return .after(Date().addingTimeInterval(errorDismissal))
        }
        return .after(Date().addingTimeInterval(successDismissal))
    }

    static func endImmediately(_ activity: Activity<OpenChamberActivityAttributes>) async {
        cancelPushTokenTask(for: activity.id)
        let content = ActivityContent(
            state: activity.content.state,
            staleDate: activity.content.staleDate
        )
        await activity.end(content, dismissalPolicy: .immediate)
    }

    static func ensurePushTokenUpdates(for activity: Activity<OpenChamberActivityAttributes>) {
        let activityId = activity.id
        if pushTokenTasks[activityId] != nil {
            return
        }
        let sessionId = activity.attributes.sessionID
        pushTokenTasks[activityId] = Task {
            for await pushToken in activity.pushTokenUpdates {
                if Task.isCancelled { break }
                emitPushToken(
                    activityId: activityId,
                    sessionId: sessionId,
                    token: hexString(from: pushToken)
                )
            }
        }
    }

    static func cancelPushTokenTask(for activityId: String) {
        pushTokenTasks[activityId]?.cancel()
        pushTokenTasks.removeValue(forKey: activityId)
    }

    static func emitPushToken(activityId: String, sessionId: String, token: String) {
        guard !token.isEmpty else { return }
        let listener = pushTokenListener
        DispatchQueue.main.async {
            listener?(activityId, sessionId, token)
        }
    }

    static func hexString(from token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}
#endif
