import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// ActivityAttributes shared with a future Widget extension.
/// Deep-link rows use `openchamber://session/{id}` (built in JS / widget).
struct OpenChamberExpoActivityAttributes: Codable {
  struct ContentState: Codable, Hashable {
    var sessionId: String
    var status: String
    var eventVersion: Int
    var updatedAt: Double
    var endedAt: Double?
    var title: String
    var workingCount: Int
    var items: [Item]
  }

  struct Item: Codable, Hashable {
    var sessionId: String
    var title: String
    var status: String
    var startedAt: Double
    var endedAt: Double?
  }

  var startedAt: Double
}

#if canImport(ActivityKit) && os(iOS)
extension OpenChamberExpoActivityAttributes: ActivityAttributes {}
#endif

enum OpenChamberExpoLiveActivity {
  static let allowedStatuses: Set<String> = [
    "working", "tool", "retry", "input", "permission", "stale", "complete", "error",
  ]

  struct Request {
    var sessionId: String
    var startedAt: Double?
    var status: String
    var eventVersion: Int
    var updatedAt: Double
    var endedAt: Double?
    var dismissalSeconds: Double?
    var title: String?
    var workingCount: Int?
    var items: [OpenChamberExpoActivityAttributes.Item]?
  }

  static func isSupported() -> Bool {
    #if canImport(ActivityKit) && os(iOS)
    if #available(iOS 17.0, *) {
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }
    #endif
    return false
  }

  static func parse(_ raw: [String: Any], requireStartedAt: Bool) throws -> Request {
    guard let sessionId = (raw["sessionId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !sessionId.isEmpty else {
      throw LiveError.sessionIdRequired
    }
    guard let status = (raw["status"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          allowedStatuses.contains(status) else {
      throw LiveError.statusInvalid
    }
    guard let eventVersion = intValue(raw["eventVersion"]) else { throw LiveError.eventVersionRequired }
    guard let updatedAt = doubleValue(raw["updatedAt"]) else { throw LiveError.updatedAtRequired }
    let startedAt = doubleValue(raw["startedAt"])
    if requireStartedAt && startedAt == nil { throw LiveError.startedAtRequired }
    var items: [OpenChamberExpoActivityAttributes.Item]?
    if let rawItems = raw["items"] as? [[String: Any]] {
      items = rawItems.compactMap { item in
        guard let sid = item["sessionId"] as? String, !sid.isEmpty,
              let st = item["status"] as? String, allowedStatuses.contains(st),
              let started = doubleValue(item["startedAt"]) else { return nil }
        return .init(
          sessionId: sid,
          title: (item["title"] as? String) ?? "",
          status: st,
          startedAt: started,
          endedAt: doubleValue(item["endedAt"])
        )
      }
    }
    return Request(
      sessionId: sessionId,
      startedAt: startedAt,
      status: status,
      eventVersion: eventVersion,
      updatedAt: updatedAt,
      endedAt: doubleValue(raw["endedAt"]),
      dismissalSeconds: doubleValue(raw["dismissalSeconds"]),
      title: raw["title"] as? String,
      workingCount: intValue(raw["workingCount"]),
      items: items
    )
  }

  static func start(_ request: Request) async throws -> String? {
    #if canImport(ActivityKit) && os(iOS)
    if #available(iOS 17.0, *) {
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { throw LiveError.disabled }
      let state = contentState(from: request)
      let attributes = OpenChamberExpoActivityAttributes(startedAt: request.startedAt ?? request.updatedAt)
      let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(20 * 60))
      let activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
      return activity.id
    }
    #endif
    throw LiveError.unsupported
  }

  static func update(_ request: Request) async throws {
    #if canImport(ActivityKit) && os(iOS)
    if #available(iOS 17.0, *) {
      let state = contentState(from: request)
      for activity in Activity<OpenChamberExpoActivityAttributes>.activities {
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(20 * 60))
        await activity.update(content)
      }
      return
    }
    #endif
    throw LiveError.unsupported
  }

  static func end(_ request: Request) async throws {
    #if canImport(ActivityKit) && os(iOS)
    if #available(iOS 17.0, *) {
      let state = contentState(from: request)
      let dismissal: Date
      if request.status == "error" {
        dismissal = Date().addingTimeInterval(request.dismissalSeconds ?? 3600)
      } else {
        dismissal = Date().addingTimeInterval(request.dismissalSeconds ?? 900)
      }
      for activity in Activity<OpenChamberExpoActivityAttributes>.activities {
        let content = ActivityContent(state: state, staleDate: nil)
        await activity.end(content, dismissalPolicy: .after(dismissal))
      }
      return
    }
    #endif
    throw LiveError.unsupported
  }

  private static func contentState(from request: Request) -> OpenChamberExpoActivityAttributes.ContentState {
    OpenChamberExpoActivityAttributes.ContentState(
      sessionId: request.sessionId,
      status: request.status,
      eventVersion: request.eventVersion,
      updatedAt: request.updatedAt,
      endedAt: request.endedAt,
      title: request.title ?? "",
      workingCount: request.workingCount ?? (request.items?.count ?? 1),
      items: request.items ?? [
        .init(
          sessionId: request.sessionId,
          title: request.title ?? "",
          status: request.status,
          startedAt: request.startedAt ?? request.updatedAt,
          endedAt: request.endedAt
        ),
      ]
    )
  }

  private static func intValue(_ value: Any?) -> Int? {
    if let n = value as? Int { return n }
    if let n = value as? NSNumber { return n.intValue }
    if let s = value as? String { return Int(s) }
    return nil
  }

  private static func doubleValue(_ value: Any?) -> Double? {
    if let n = value as? Double { return n }
    if let n = value as? Int { return Double(n) }
    if let n = value as? NSNumber { return n.doubleValue }
    if let s = value as? String { return Double(s) }
    return nil
  }

  enum LiveError: LocalizedError {
    case sessionIdRequired, startedAtRequired, statusInvalid, eventVersionRequired, updatedAtRequired, unsupported, disabled
    var errorDescription: String? {
      switch self {
      case .sessionIdRequired: return "sessionId is required"
      case .startedAtRequired: return "startedAt is required"
      case .statusInvalid: return "status is invalid"
      case .eventVersionRequired: return "eventVersion is required"
      case .updatedAtRequired: return "updatedAt is required"
      case .unsupported: return "Live Activities are not supported"
      case .disabled: return "Live Activities are disabled"
      }
    }
  }
}
