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

/// Liquid-glass suggestion list above the native composer card.
/// Width matches the card. Height is clamped by the caller so it stays
/// below the mobile header.
final class OpenChamberComposerAutocompleteView: UIView, UITableViewDelegate, UITableViewDataSource {
    var onAccept: ((Int) -> Void)?

    private let chrome = GlassBackdropView()
    private let tableView = UITableView(frame: .zero, style: .plain)
    private var rows: [ComposerAutocompleteRow] = []
    private var highlightedIndex = 0
    private var appearanceIsDark = true

    static let rowHeight: CGFloat = 48
    private static let verticalInset: CGFloat = 6

    var contentHeight: CGFloat {
        guard !rows.isEmpty else { return 0 }
        return CGFloat(rows.count) * Self.rowHeight + Self.verticalInset * 2
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        isHidden = true
        isOpaque = false
        backgroundColor = .clear
        chrome.setCornerRadius(18)
        chrome.translatesAutoresizingMaskIntoConstraints = false
        addSubview(chrome)

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = .clear
        tableView.separatorStyle = .none
        tableView.rowHeight = Self.rowHeight
        tableView.estimatedRowHeight = Self.rowHeight
        tableView.delegate = self
        tableView.dataSource = self
        tableView.keyboardDismissMode = .none
        tableView.allowsSelection = true
        tableView.showsVerticalScrollIndicator = true
        tableView.contentInset = UIEdgeInsets(top: Self.verticalInset, left: 0, bottom: Self.verticalInset, right: 0)
        tableView.scrollIndicatorInsets = tableView.contentInset
        tableView.register(ComposerAutocompleteCell.self, forCellReuseIdentifier: ComposerAutocompleteCell.reuseId)
        if #available(iOS 15.0, *) {
            tableView.sectionHeaderTopPadding = 0
        }
        chrome.contentView.addSubview(tableView)

        NSLayoutConstraint.activate([
            chrome.topAnchor.constraint(equalTo: topAnchor),
            chrome.bottomAnchor.constraint(equalTo: bottomAnchor),
            chrome.leadingAnchor.constraint(equalTo: leadingAnchor),
            chrome.trailingAnchor.constraint(equalTo: trailingAnchor),
            tableView.topAnchor.constraint(equalTo: chrome.contentView.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: chrome.contentView.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: chrome.contentView.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: chrome.contentView.trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func applyAppearance(isDark: Bool) {
        appearanceIsDark = isDark
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
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let badgeLabel = UILabel()
    private let highlight = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        selectionStyle = .none
        contentView.backgroundColor = .clear

        highlight.translatesAutoresizingMaskIntoConstraints = false
        highlight.layer.cornerRadius = 10
        highlight.layer.cornerCurve = .continuous
        highlight.isHidden = true

        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.contentMode = .scaleAspectFit

        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.numberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        subtitleLabel.font = .systemFont(ofSize: 12, weight: .regular)
        subtitleLabel.numberOfLines = 1
        subtitleLabel.lineBreakMode = .byTruncatingTail

        badgeLabel.font = .systemFont(ofSize: 10, weight: .bold)
        badgeLabel.numberOfLines = 1
        badgeLabel.setContentHuggingPriority(.required, for: .horizontal)
        badgeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let textStack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
        textStack.axis = .vertical
        textStack.spacing = 1
        textStack.translatesAutoresizingMaskIntoConstraints = false

        contentView.addSubview(highlight)
        contentView.addSubview(iconView)
        contentView.addSubview(textStack)
        contentView.addSubview(badgeLabel)

        NSLayoutConstraint.activate([
            highlight.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 2),
            highlight.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -2),
            highlight.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 6),
            highlight.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -6),
            iconView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            iconView.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 16),
            iconView.heightAnchor.constraint(equalToConstant: 16),
            textStack.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 10),
            textStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            textStack.trailingAnchor.constraint(lessThanOrEqualTo: badgeLabel.leadingAnchor, constant: -8),
            badgeLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            badgeLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    func apply(_ row: ComposerAutocompleteRow, highlighted: Bool, isDark: Bool) {
        let label = isDark ? UIColor.white : UIColor.black
        iconView.image = row.icon?.withRenderingMode(.alwaysTemplate)
        iconView.tintColor = label
        titleLabel.text = row.title
        titleLabel.textColor = label
        subtitleLabel.text = row.subtitle
        subtitleLabel.isHidden = row.subtitle.isEmpty
        subtitleLabel.textColor = label.withAlphaComponent(0.55)
        badgeLabel.text = row.badge.uppercased()
        badgeLabel.isHidden = row.badge.isEmpty
        badgeLabel.textColor = label.withAlphaComponent(0.55)
        highlight.backgroundColor = label.withAlphaComponent(highlighted ? 0.12 : 0)
        highlight.isHidden = !highlighted
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
