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

    init(contentState: OpenChamberActivityAttributes.ContentState) {
        self = LiveActivityStatus(rawValue: contentState.status) ?? .stale
    }

    var color: Color {
        switch self {
        case .working, .input:
            return .orange
        case .tool:
            return .cyan
        case .retry:
            return .yellow
        case .permission:
            return .purple
        case .stale:
            return .gray
        case .complete:
            return .green
        case .error:
            return .red
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

    var displayTitle: LocalizedStringKey {
        switch self {
        case .working:
            return "Working"
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

private struct LiveActivityStatusGlyph: View {
    let status: LiveActivityStatus
    let eventVersion: Int
    let size: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var motionEnabled: Bool {
        !reduceMotion && !isLuminanceReduced
    }

    var body: some View {
        ZStack {
            outline
            symbol
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(status.accessibilityLabel))
    }

    @ViewBuilder
    private var outline: some View {
        if status == .stale {
            Circle()
                .stroke(
                    Color.primary.opacity(0.72),
                    style: StrokeStyle(
                        lineWidth: max(1, size * 0.055),
                        lineCap: .round,
                        dash: [size * 0.12, size * 0.1]
                    )
                )
        } else {
            Circle()
                .stroke(Color.primary.opacity(0.62), lineWidth: max(1, size * 0.055))
        }
    }

    @ViewBuilder
    private var symbol: some View {
        switch status {
        case .working:
            animatedOrb
        case .tool:
            animatedTool
        case .retry:
            animatedRetry
        case .input:
            discreteSymbol("questionmark.bubble.fill")
        case .permission:
            discreteSymbol("hand.raised.fill")
        case .stale:
            Image(systemName: "wifi.slash")
                .font(.system(size: size * 0.44, weight: .semibold))
                .foregroundStyle(status.color)
        case .complete:
            discreteSymbol("checkmark")
        case .error:
            discreteSymbol("exclamationmark.triangle.fill")
        }
    }

    private var animatedOrb: some View {
        TimelineView(.animation(minimumInterval: 0.5, paused: !motionEnabled)) { context in
            let rotation = motionEnabled
                ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 4.0) / 4.0 * 360
                : 36

            ZStack {
                Circle()
                    .fill(status.color)
                    .frame(width: size * 0.28, height: size * 0.28)
                Circle()
                    .fill(status.color)
                    .frame(width: size * 0.13, height: size * 0.13)
                    .offset(y: -size * 0.31)
                    .rotationEffect(.degrees(rotation))
            }
        }
    }

    private var animatedTool: some View {
        TimelineView(.animation(minimumInterval: 0.5, paused: !motionEnabled)) { context in
            let pulse = motionEnabled
                ? 1 + sin(context.date.timeIntervalSinceReferenceDate * 1.6) * 0.04
                : 1

            Image(systemName: "wrench.and.screwdriver.fill")
                .font(.system(size: size * 0.43, weight: .semibold))
                .foregroundStyle(status.color)
                .scaleEffect(pulse)
        }
    }

    private var animatedRetry: some View {
        TimelineView(.animation(minimumInterval: 0.5, paused: !motionEnabled)) { context in
            let rotation = motionEnabled
                ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.5) / 2.5 * 360
                : 24

            Image(systemName: "arrow.clockwise")
                .font(.system(size: size * 0.48, weight: .bold))
                .foregroundStyle(status.color)
                .rotationEffect(.degrees(rotation))
        }
    }

    private func discreteSymbol(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.44, weight: .semibold))
            .foregroundStyle(status.color)
            .symbolEffect(.bounce, value: motionEnabled ? eventVersion : 0)
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
            let nextElapsed: TimeInterval

            if elapsed < 60 {
                nextElapsed = floor(elapsed) + 1
            } else {
                nextElapsed = (floor(elapsed / 60) + 1) * 60
            }

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
    let compact: Bool

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
        if elapsed < 60 {
            return "\(Int(floor(elapsed)))S"
        }
        return "\(Int(floor(elapsed / 60)))M"
    }

    private func elapsedText(at date: Date) -> some View {
        let formatted = formattedElapsed(at: date)

        return Text(verbatim: formatted)
            .font(.system(size: compact ? 12 : 27, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, compact ? 2 : 0)
            .accessibilityLabel(Text("Elapsed time"))
            .accessibilityValue(Text(verbatim: formatted))
    }
}

private struct LiveActivityFreshness: View {
    let status: LiveActivityStatus
    let updatedAt: Double
    let showsLabel: Bool

    private func activeSegments(at date: Date) -> Int {
        guard status != .stale, updatedAt.isFinite else {
            return 0
        }

        let age = max(0, date.timeIntervalSince1970 - updatedAt)
        if age < 2 * 60 { return 4 }
        if age < 5 * 60 { return 3 }
        if age < 10 * 60 { return 2 }
        if age < 20 * 60 { return 1 }
        return 0
    }

    private func accessibilityLabel(for activeSegments: Int) -> LocalizedStringKey {
        switch activeSegments {
        case 4:
            return "Updated just now"
        case 2...3:
            return "Updated recently"
        case 1:
            return "Update is aging"
        default:
            return "Update delayed"
        }
    }

    private func displayLabel(for activeSegments: Int) -> LocalizedStringKey {
        switch activeSegments {
        case 4:
            return "Updated now"
        case 2...3:
            return "Updated recently"
        case 1:
            return "Last update aging"
        default:
            return "Refresh overdue"
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let activeSegments = activeSegments(at: context.date)

            HStack(spacing: 3) {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .fill(index < activeSegments ? status.color : Color.clear)
                        .overlay {
                            Circle()
                                .stroke(Color.primary.opacity(0.58), lineWidth: 1)
                        }
                        .frame(width: 5, height: 5)
                }

                if showsLabel {
                    Text(displayLabel(for: activeSegments))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(accessibilityLabel(for: activeSegments)))
        }
    }
}

private struct LiveActivityOpenIndicator: View {
    let showsLabel: Bool

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "arrow.up.forward.app")
            if showsLabel {
                Text("Open session")
            }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Open session"))
    }
}

private struct LiveActivityLockScreenView: View {
    let context: ActivityViewContext<OpenChamberActivityAttributes>

    private var status: LiveActivityStatus {
        LiveActivityStatus(contentState: context.state)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 11) {
                LiveActivityStatusGlyph(
                    status: status,
                    eventVersion: context.state.eventVersion,
                    size: 42
                )

                Text(status.displayTitle)
                    .font(.headline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)

                Spacer(minLength: 10)

                LiveActivityElapsedTime(
                    startedAt: context.attributes.startedAt,
                    endedAt: context.state.endedAt,
                    compact: false
                )
            }

            Divider()
                .overlay(status.color.opacity(0.32))

            HStack(spacing: 10) {
                LiveActivityFreshness(
                    status: status,
                    updatedAt: context.state.updatedAt,
                    showsLabel: true
                )

                Spacer(minLength: 8)

                LiveActivityOpenIndicator(showsLabel: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .activitySystemActionForegroundColor(.primary)
        .widgetURL(WidgetDeepLink.session(context.attributes.sessionID))
    }
}

struct OpenChamberLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenChamberActivityAttributes.self) { context in
            LiveActivityLockScreenView(context: context)
        } dynamicIsland: { context in
            let status = LiveActivityStatus(contentState: context.state)

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 9) {
                        LiveActivityStatusGlyph(
                            status: status,
                            eventVersion: context.state.eventVersion,
                            size: 38
                        )
                        Text(status.displayTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    LiveActivityElapsedTime(
                        startedAt: context.attributes.startedAt,
                        endedAt: context.state.endedAt,
                        compact: false
                    )
                    .padding(.trailing, 4)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 10) {
                        LiveActivityFreshness(
                            status: status,
                            updatedAt: context.state.updatedAt,
                            showsLabel: true
                        )

                        Spacer(minLength: 8)

                        LiveActivityOpenIndicator(showsLabel: true)
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 9)
                    .overlay(alignment: .top) {
                        Divider()
                            .overlay(status.color.opacity(0.38))
                    }
                }
            } compactLeading: {
                LiveActivityStatusGlyph(
                    status: status,
                    eventVersion: context.state.eventVersion,
                    size: 22
                )
            } compactTrailing: {
                LiveActivityElapsedTime(
                    startedAt: context.attributes.startedAt,
                    endedAt: context.state.endedAt,
                    compact: true
                )
            } minimal: {
                LiveActivityStatusGlyph(
                    status: status,
                    eventVersion: context.state.eventVersion,
                    size: 22
                )
            }
            .widgetURL(WidgetDeepLink.session(context.attributes.sessionID))
            .keylineTint(status.color)
        }
    }
}
