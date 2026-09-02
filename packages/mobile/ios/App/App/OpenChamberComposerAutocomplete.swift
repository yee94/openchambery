import UIKit

struct ComposerAutocompleteRow {
    let id: String
    let title: String
    let subtitle: String
    let badge: String
    let icon: UIImage?
}

struct ComposerAutocompleteState {
    let open: Bool
    let highlightedIndex: Int
    let rows: [ComposerAutocompleteRow]

    static let closed = ComposerAutocompleteState(open: false, highlightedIndex: 0, rows: [])
}

/// Geometry shared with `computeMobileAutocompleteMaxHeight` in
/// `packages/ui/src/components/chat/useMobileAutocompleteMaxHeight.ts`.
enum ComposerAutocompleteMetrics {
    static let rowHeight: CGFloat = 48
    static let verticalInset: CGFloat = 6
    static let gap: CGFloat = 8
    static let navigationContentHeight: CGFloat = 56
    static let minPaintHeight: CGFloat = 36
    static let viewportRatio: CGFloat = 0.4
    static let softMinHeight: CGFloat = 120

    static func contentHeight(rowCount: Int) -> CGFloat {
        guard rowCount > 0 else { return 0 }
        return CGFloat(rowCount) * rowHeight + verticalInset * 2
    }

    static func headerFloor(safeAreaTop: CGFloat) -> CGFloat {
        safeAreaTop + navigationContentHeight
    }

    static func maxHeight(popupBottom: CGFloat, boundaryTop: CGFloat, viewportHeight: CGFloat) -> CGFloat {
        let available = max(0, popupBottom - boundaryTop - gap)
        let viewportCap = viewportHeight * viewportRatio
        let capped = floor(min(available, viewportCap))
        if available >= softMinHeight {
            return min(available, max(softMinHeight, capped))
        }
        return capped
    }

    static func chromeColor(isDark: Bool) -> UIColor {
        isDark ? UIColor(white: 1, alpha: 1) : UIColor(white: 0, alpha: 1)
    }
}

/// Liquid-glass suggestion list above the native composer card.
/// Width matches the card. Height is clamped by the caller so it stays
/// below the mobile header and within 40% of the visible column.
final class OpenChamberComposerAutocompleteView: UIView, UITableViewDelegate, UITableViewDataSource {
    var onAccept: ((Int) -> Void)?

    private let chrome = GlassBackdropView()
    private let tableView = UITableView(frame: .zero, style: .plain)
    private var rows: [ComposerAutocompleteRow] = []
    private var highlightedIndex = 0
    private var appearanceIsDark = true

    var contentHeight: CGFloat {
        ComposerAutocompleteMetrics.contentHeight(rowCount: rows.count)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let local = convert(point, to: tableView)
        if tableView.point(inside: local, with: event) {
            return tableView.hitTest(local, with: event) ?? tableView
        }
        return super.hitTest(point, with: event)
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        isHidden = true
        isOpaque = false
        backgroundColor = .clear
        chrome.setCornerRadius(18)
        chrome.translatesAutoresizingMaskIntoConstraints = false
        // Interactive UIGlassEffect samples presses through its own view.
        // The table is a sibling on top; chrome must not steal the tap.
        chrome.isUserInteractionEnabled = false
        addSubview(chrome)

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = .clear
        tableView.separatorStyle = .none
        tableView.rowHeight = ComposerAutocompleteMetrics.rowHeight
        tableView.estimatedRowHeight = ComposerAutocompleteMetrics.rowHeight
        tableView.delegate = self
        tableView.dataSource = self
        tableView.keyboardDismissMode = .none
        tableView.allowsSelection = true
        // Default delaysContentTouches waits to see if the finger is a pan.
        // A full-cell UIButton plus delaysContentTouches=false ate that pan,
        // so the clamped list could not scroll. Selection is didSelectRowAt.
        tableView.delaysContentTouches = true
        tableView.canCancelContentTouches = true
        tableView.isScrollEnabled = true
        tableView.alwaysBounceVertical = false
        tableView.showsVerticalScrollIndicator = true
        tableView.contentInset = UIEdgeInsets(
            top: ComposerAutocompleteMetrics.verticalInset,
            left: 0,
            bottom: ComposerAutocompleteMetrics.verticalInset,
            right: 0
        )
        tableView.scrollIndicatorInsets = tableView.contentInset
        tableView.contentInsetAdjustmentBehavior = .never
        tableView.insetsContentViewsToSafeArea = false
        tableView.cellLayoutMarginsFollowReadableWidth = false
        tableView.layer.cornerRadius = 18
        tableView.layer.cornerCurve = .continuous
        tableView.clipsToBounds = true
        tableView.register(ComposerAutocompleteCell.self, forCellReuseIdentifier: ComposerAutocompleteCell.reuseId)
        if #available(iOS 15.0, *) {
            tableView.sectionHeaderTopPadding = 0
        }
        // Stay a sibling of the glass. UIGlassEffect applies vibrancy to
        // UILabel inside contentView, which ate the titles while icons
        // (UIImageView) still painted.
        addSubview(tableView)

        NSLayoutConstraint.activate([
            chrome.topAnchor.constraint(equalTo: topAnchor),
            chrome.bottomAnchor.constraint(equalTo: bottomAnchor),
            chrome.leadingAnchor.constraint(equalTo: leadingAnchor),
            chrome.trailingAnchor.constraint(equalTo: trailingAnchor),
            tableView.topAnchor.constraint(equalTo: topAnchor),
            tableView.bottomAnchor.constraint(equalTo: bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func applyAppearance(isDark: Bool) {
        appearanceIsDark = isDark
        let style: UIUserInterfaceStyle = isDark ? .dark : .light
        overrideUserInterfaceStyle = style
        tableView.overrideUserInterfaceStyle = style
        tableView.indicatorStyle = isDark ? .white : .black
        chrome.appearanceIsDark = isDark
        chrome.refreshEffect()
        tableView.reloadData()
    }

    func apply(_ state: ComposerAutocompleteState, expanded: Bool) {
        rows = state.rows
        highlightedIndex = rows.isEmpty ? 0 : min(max(0, state.highlightedIndex), rows.count - 1)
        let visible = state.open && expanded && !rows.isEmpty
        isHidden = !visible
        isUserInteractionEnabled = visible
        tableView.reloadData()
        if visible, rows.indices.contains(highlightedIndex) {
            tableView.selectRow(
                at: IndexPath(row: highlightedIndex, section: 0),
                animated: false,
                scrollPosition: .none
            )
        }
    }

    func revealHighlightedRow() {
        guard !isHidden, rows.indices.contains(highlightedIndex) else { return }
        let path = IndexPath(row: highlightedIndex, section: 0)
        tableView.scrollToRow(at: path, at: highlightedIndex == 0 ? .top : .none, animated: false)
        if highlightedIndex == 0 {
            tableView.setContentOffset(
                CGPoint(x: 0, y: -tableView.adjustedContentInset.top),
                animated: false
            )
        }
    }

    func acceptHighlighted() {
        guard !isHidden, rows.indices.contains(highlightedIndex) else { return }
        onAccept?(highlightedIndex)
    }

    func numberOfSections(in tableView: UITableView) -> Int { 1 }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(
            withIdentifier: ComposerAutocompleteCell.reuseId,
            for: indexPath
        ) as? ComposerAutocompleteCell ?? ComposerAutocompleteCell()
        if let row = rows[safe: indexPath.row] {
            cell.apply(row, highlighted: indexPath.row == highlightedIndex, isDark: appearanceIsDark)
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        highlightedIndex = indexPath.row
        onAccept?(indexPath.row)
    }
}

private final class ComposerAutocompleteCell: UITableViewCell {
    static let reuseId = "OpenChamberComposerAutocompleteCell"

    private let iconView = UIImageView()
    private let titleView = UIImageView()
    private let subtitleView = UIImageView()
    private let badgeView = UIImageView()
    private let highlight = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.backgroundColor = .clear
        preservesSuperviewLayoutMargins = false
        contentView.preservesSuperviewLayoutMargins = false
        contentView.insetsLayoutMarginsFromSafeArea = false
        insetsLayoutMarginsFromSafeArea = false
        layoutMargins = .zero
        contentView.layoutMargins = .zero
        isAccessibilityElement = true

        highlight.translatesAutoresizingMaskIntoConstraints = false
        highlight.layer.cornerRadius = 10
        highlight.layer.cornerCurve = .continuous
        highlight.isHidden = true

        for imageView in [iconView, titleView, subtitleView, badgeView] {
            imageView.translatesAutoresizingMaskIntoConstraints = false
            imageView.clipsToBounds = true
        }
        iconView.contentMode = .scaleAspectFit
        titleView.contentMode = .left
        subtitleView.contentMode = .left
        badgeView.contentMode = .right
        iconView.setContentHuggingPriority(.required, for: .horizontal)
        iconView.setContentCompressionResistancePriority(.required, for: .horizontal)
        badgeView.setContentHuggingPriority(.required, for: .horizontal)
        badgeView.setContentCompressionResistancePriority(.required, for: .horizontal)
        titleView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        subtitleView.setContentHuggingPriority(.defaultLow, for: .horizontal)

        contentView.addSubview(highlight)
        contentView.addSubview(iconView)
        contentView.addSubview(titleView)
        contentView.addSubview(subtitleView)
        contentView.addSubview(badgeView)

        NSLayoutConstraint.activate([
            highlight.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 2),
            highlight.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -2),
            highlight.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 6),
            highlight.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -6),
            iconView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            iconView.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 16),
            iconView.heightAnchor.constraint(equalToConstant: 16),
            titleView.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 10),
            titleView.trailingAnchor.constraint(lessThanOrEqualTo: badgeView.leadingAnchor, constant: -8),
            titleView.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -14),
            titleView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
            titleView.heightAnchor.constraint(equalToConstant: 18),
            subtitleView.leadingAnchor.constraint(equalTo: titleView.leadingAnchor),
            subtitleView.trailingAnchor.constraint(equalTo: titleView.trailingAnchor),
            subtitleView.topAnchor.constraint(equalTo: titleView.bottomAnchor, constant: 1),
            subtitleView.heightAnchor.constraint(equalToConstant: 14),
            badgeView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            badgeView.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            badgeView.heightAnchor.constraint(equalToConstant: 14),
            badgeView.widthAnchor.constraint(lessThanOrEqualToConstant: 88),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    func apply(_ row: ComposerAutocompleteRow, highlighted: Bool, isDark: Bool) {
        let color = ComposerAutocompleteMetrics.chromeColor(isDark: isDark)
        let muted = color.withAlphaComponent(0.58)
        iconView.image = row.icon?.withRenderingMode(.alwaysTemplate)
        iconView.tintColor = color
        iconView.isHidden = row.icon == nil
        titleView.image = Self.raster(
            row.title,
            font: .systemFont(ofSize: 15, weight: .semibold),
            color: color,
            maxWidth: 280
        )
        titleView.isHidden = row.title.isEmpty
        subtitleView.image = Self.raster(
            row.subtitle,
            font: .systemFont(ofSize: 12, weight: .regular),
            color: muted,
            maxWidth: 280
        )
        subtitleView.isHidden = row.subtitle.isEmpty
        badgeView.image = Self.raster(
            row.badge.uppercased(),
            font: .systemFont(ofSize: 10, weight: .bold),
            color: muted,
            maxWidth: 88
        )
        badgeView.isHidden = row.badge.isEmpty
        highlight.backgroundColor = color.withAlphaComponent(highlighted ? 0.12 : 0)
        highlight.isHidden = !highlighted
        accessibilityLabel = [row.title, row.subtitle, row.badge]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }

    /// Same path as the sprite icons: a bitmap, not a UILabel. Glass vibrancy
    /// does not eat UIImageView the way it eats UILabel.
    private static func raster(_ text: String, font: UIFont, color: UIColor, maxWidth: CGFloat) -> UIImage? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
        ]
        let bound = (trimmed as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: font.lineHeight + 4),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: attrs,
            context: nil
        )
        let size = CGSize(
            width: max(1, min(maxWidth, ceil(bound.width))),
            height: max(1, ceil(bound.height))
        )
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in
            (trimmed as NSString).draw(
                with: CGRect(origin: .zero, size: size),
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                attributes: attrs,
                context: nil
            )
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
