import ActivityKit
import SwiftUI
import WidgetKit

private enum LiveActivityStatus: String {
    case working
    case tool
    case retry
    case input
    case permission
    case stale
    case complete
    case error

    init(raw: String) {
        self = LiveActivityStatus(rawValue: raw) ?? .stale
    }

    var isWorking: Bool {
        switch self {
        case .complete, .error:
            return false
        default:
            return true
        }
    }

    var accessibilityLabel: LocalizedStringKey {
        switch self {
        case .working:
            return "Agent working"
        case .tool:
            return "Running a tool"
        case .retry:
            return "Retrying"
        case .input:
            return "Input needed"
        case .permission:
            return "Permission needed"
        case .stale:
            return "Update delayed"
        case .complete:
            return "Response ready"
        case .error:
            return "Agent error"
        }
    }
}

private struct LiveActivityRow: Identifiable {
    let sessionID: String
    let title: String
    let status: LiveActivityStatus
    let startedAt: Double
    let endedAt: Double?

    var id: String { sessionID }
}

private func liveActivityRows(
    attributes: OpenChamberActivityAttributes,
    state: OpenChamberActivityAttributes.ContentState
) -> [LiveActivityRow] {
    if let items = state.items, !items.isEmpty {
        return items.map { item in
            LiveActivityRow(
                sessionID: item.sessionID,
                title: item.title,
                status: LiveActivityStatus(raw: item.status),
                startedAt: item.startedAt,
                endedAt: item.endedAt
            )
        }
    }

    return [
        LiveActivityRow(
            sessionID: attributes.sessionID,
            title: state.title ?? "",
            status: LiveActivityStatus(raw: state.status),
            startedAt: attributes.startedAt,
            endedAt: state.endedAt
        ),
    ]
}

private func liveActivityWorkingCount(
    state: OpenChamberActivityAttributes.ContentState,
    rows: [LiveActivityRow]
) -> Int {
    if let workingCount = state.workingCount {
        return max(0, workingCount)
    }
    return rows.filter(\.status.isWorking).count
}

private struct LiveActivityWorkingGlyph: View {
    let size: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var motionEnabled: Bool {
        !reduceMotion && !isLuminanceReduced
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.45, paused: !motionEnabled)) { context in
            let rotation = motionEnabled
                ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4 * 360
                : 0

            ZStack {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .fill(Color.primary.opacity(0.92))
                        .frame(width: size * 0.22, height: size * 0.22)
                        .offset(y: -size * 0.30)
                        .rotationEffect(.degrees(Double(index) * 90 + rotation))
                }
            }
        }
        .frame(width: size, height: size)
    }
}

private struct LiveActivityRowGlyph: View {
    let status: LiveActivityStatus
    let size: CGFloat

    var body: some View {
        Group {
            if status.isWorking {
                LiveActivityWorkingGlyph(size: size)
            } else if status == .error {
                Image(systemName: "exclamationmark")
                    .font(.system(size: size * 0.72, weight: .semibold))
                    .foregroundStyle(.primary.opacity(0.85))
            } else {
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.72, weight: .semibold))
                    .foregroundStyle(.primary.opacity(0.85))
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(status.accessibilityLabel))
    }
}

private struct LiveActivityElapsedSchedule: TimelineSchedule {
    let startedAt: Date

    struct Entries: Sequence, IteratorProtocol {
        var nextDate: Date
        let startedAt: Date

        mutating func next() -> Date? {
            let entry = nextDate
            let elapsed = Swift.max(0, entry.timeIntervalSince(startedAt))
            let nextElapsed = (floor(elapsed / 60) + 1) * 60
            nextDate = startedAt.addingTimeInterval(nextElapsed)
            return entry
        }
    }

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> Entries {
        Entries(nextDate: startDate, startedAt: startedAt)
    }
}

private struct LiveActivityElapsedTime: View {
    let startedAt: Double
    let endedAt: Double?

    private var startDate: Date {
        Date(timeIntervalSince1970: startedAt)
    }

    private var frozenDate: Date? {
        guard let endedAt, endedAt.isFinite else { return nil }
        return Date(timeIntervalSince1970: max(startedAt, endedAt))
    }

    @ViewBuilder
    var body: some View {
        if let frozenDate {
            elapsedText(at: frozenDate)
        } else {
            TimelineView(LiveActivityElapsedSchedule(startedAt: startDate)) { context in
                elapsedText(at: context.date)
            }
        }
    }

    private func formattedElapsed(at date: Date) -> String {
        let elapsed = max(0, date.timeIntervalSince(startDate))
        return "\(Int(floor(elapsed / 60)))m"
    }

    private func elapsedText(at date: Date) -> some View {
        let formatted = formattedElapsed(at: date)

        return Text(verbatim: formatted)
            .font(.system(size: 13, weight: .regular, design: .rounded))
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel(Text("Elapsed time"))
            .accessibilityValue(Text(verbatim: formatted))
    }
}

private struct LiveActivitySessionRow: View {
    let row: LiveActivityRow
    let compact: Bool

    private var title: String {
        row.title.isEmpty ? "Session" : row.title
    }

    private var rowBody: some View {
        HStack(alignment: .center, spacing: 8) {
            LiveActivityRowGlyph(status: row.status, size: compact ? 12 : 14)

            Text(title)
                .font(.system(size: compact ? 13 : 15, weight: .regular))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 8)

            LiveActivityElapsedTime(startedAt: row.startedAt, endedAt: row.endedAt)
        }
        .contentShape(Rectangle())
    }

    var body: some View {
        if row.sessionID.isEmpty || row.sessionID == "live" {
            rowBody
        } else {
            Link(destination: WidgetDeepLink.session(row.sessionID)) {
                rowBody
            }
            .accessibilityLabel(Text(title))
        }
    }
}

private struct LiveActivitySessionList: View {
    let rows: [LiveActivityRow]
    let workingCount: Int
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 7 : 9) {
            Text("\(workingCount) working")
                .font(.system(size: compact ? 13 : 15, weight: .regular))
                .foregroundStyle(.secondary)
                .lineLimit(1)

            VStack(spacing: compact ? 7 : 9) {
                ForEach(rows) { row in
                    LiveActivitySessionRow(row: row, compact: compact)
                }
            }
        }
    }
}

private struct LiveActivityLockScreenView: View {
    let context: ActivityViewContext<OpenChamberActivityAttributes>

    private var rows: [LiveActivityRow] {
        liveActivityRows(attributes: context.attributes, state: context.state)
    }

    private var workingCount: Int {
        liveActivityWorkingCount(state: context.state, rows: rows)
    }

    private var deepLinkSessionID: String {
        rows.first(where: { $0.status.isWorking })?.sessionID ?? context.attributes.sessionID
    }

    var body: some View {
        LiveActivitySessionList(rows: rows, workingCount: workingCount, compact: false)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .activitySystemActionForegroundColor(.primary)
            .widgetURL(WidgetDeepLink.session(deepLinkSessionID))
    }
}

struct OpenChamberLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenChamberActivityAttributes.self) { context in
            LiveActivityLockScreenView(context: context)
        } dynamicIsland: { context in
            let rows = liveActivityRows(attributes: context.attributes, state: context.state)
            let workingCount = liveActivityWorkingCount(state: context.state, rows: rows)
            let focus = rows.first(where: { $0.status.isWorking }) ?? rows.first
            let deepLinkSessionID = focus?.sessionID ?? context.attributes.sessionID

            return DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    LiveActivitySessionList(rows: rows, workingCount: workingCount, compact: true)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                LiveActivityRowGlyph(status: focus?.status ?? .working, size: 18)
            } compactTrailing: {
                if let focus {
                    LiveActivityElapsedTime(startedAt: focus.startedAt, endedAt: focus.endedAt)
                }
            } minimal: {
                LiveActivityRowGlyph(status: focus?.status ?? .working, size: 18)
            }
            .widgetURL(WidgetDeepLink.session(deepLinkSessionID))
            .keylineTint(.primary)
        }
    }
}
