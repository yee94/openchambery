#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import Foundation

// IMPORTANT: this file is a member of BOTH the App target and the OpenChamberWidget target.
// The app owns ActivityKit lifecycle; the widget extension renders the Live Activity UI.
// Runtime methods are gated at iOS 17.0 to match the OpenChamberWidget deployment target.
@available(iOS 17.0, *)
struct OpenChamberActivityAttributes: ActivityAttributes {
    var sessionID: String
    /// Unix epoch seconds.
    var startedAt: Double

    struct ContentState: Codable, Hashable {
        /// working / tool / retry / input / permission / stale / complete / error
        var status: String
        /// Millisecond timestamp from the live client. Recovers past small counters on restart.
        var eventVersion: Int
        /// Unix epoch seconds.
        var updatedAt: Double
        /// Unix epoch seconds. Present after the activity has ended.
        var endedAt: Double?
    }
}
#endif
