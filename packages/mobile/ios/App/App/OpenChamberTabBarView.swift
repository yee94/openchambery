import UIKit

protocol OpenChamberTabBarViewDelegate: AnyObject {
    func tabBarView(_ view: OpenChamberTabBarView, didSelectTab id: String)
    func tabBarViewDidChangeHeight(_ view: OpenChamberTabBarView)
}

struct OpenChamberTabBarItem {
    let id: String
    let label: String
    let symbol: String
    let selectedSymbol: String
}

/// Floating homepage dock. Shown only when liquid glass is available (iOS 26+);
/// older systems keep the Web tab bar.
/// iOS 26 uses interactive `UIGlassEffect`; chrome lives in the effect contentView.
/// A second interactive glass pill scrubs left/right with the finger (not vertical).
final class OpenChamberTabBarView: UIView, UIGestureRecognizerDelegate {
    weak var delegate: OpenChamberTabBarViewDelegate?

    static var supportsLiquidGlass: Bool {
        if #available(iOS 26.0, *) { return true }
        return NSClassFromString("UIGlassEffect") != nil
    }

    static let dockHeight: CGFloat = 68
    static let inlineInset: CGFloat = 16
    static let maxWidth: CGFloat = 416
    static let restFloor: CGFloat = 20

    private let glass = TabBarGlassBackdropView()
    private let selectionGlass = TabBarGlassBackdropView()
    private let stack = UIStackView()
    private let selectionFeedback = UISelectionFeedbackGenerator()
    private var buttons: [TabItemButton] = []
    private var items: [OpenChamberTabBarItem] = []
    private var selectedId = ""
    private var previewId = ""
    private var appearanceIsDark = true
    private var accentColor: UIColor?
    private var applying = false
    private var isPanning = false
    private var panStartFrame: CGRect = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        isOpaque = false
        backgroundColor = .clear
        build()
        selectionFeedback.prepare()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        if !isPanning {
            updatePill(animated: false)
        }
        delegate?.tabBarViewDidChangeHeight(self)
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: Self.dockHeight)
    }

    func apply(
        items nextItems: [OpenChamberTabBarItem],
        selectedId nextSelectedId: String?,
        appearance: String?,
        ariaLabel: String?,
        accentColor nextAccent: String?
    ) {
        applying = true
        if let appearance {
            appearanceIsDark = appearance == "dark"
            glass.appearanceIsDark = appearanceIsDark
            selectionGlass.appearanceIsDark = appearanceIsDark
            overrideUserInterfaceStyle = appearanceIsDark ? .dark : .light
        }
        if let nextAccent {
            accentColor = Self.parseHex(nextAccent)
        }
        if let ariaLabel, !ariaLabel.isEmpty {
            accessibilityLabel = ariaLabel
        }
        if !nextItems.isEmpty,
           items.map(\.id) != nextItems.map(\.id) || items.map(\.label) != nextItems.map(\.label) {
            rebuild(items: nextItems)
        }
        if let nextSelectedId, !nextSelectedId.isEmpty {
            selectedId = nextSelectedId
        } else if selectedId.isEmpty {
            selectedId = nextItems.first?.id ?? ""
        }
        previewId = selectedId
        refreshSelection()
        updatePill(animated: false)
        applying = false
    }

    private func build() {
        isAccessibilityElement = false
        accessibilityContainerType = .semanticGroup
        glass.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        selectionGlass.translatesAutoresizingMaskIntoConstraints = true
        selectionGlass.isUserInteractionEnabled = false
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.distribution = .fillEqually
        stack.spacing = 3
        stack.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(selectionGlass)
        glass.contentView.addSubview(stack)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Self.dockHeight),
            glass.topAnchor.constraint(equalTo: topAnchor),
            glass.bottomAnchor.constraint(equalTo: bottomAnchor),
            glass.leadingAnchor.constraint(equalTo: leadingAnchor),
            glass.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: glass.contentView.topAnchor, constant: 5),
            stack.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor, constant: -5),
            stack.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 5),
            stack.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -5),
        ])
        glass.setCornerRadius(Self.dockHeight / 2)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.delegate = self
        pan.cancelsTouchesInView = true
        glass.addGestureRecognizer(pan)
        selectionFeedback.prepare()
    }

    private func rebuild(items nextItems: [OpenChamberTabBarItem]) {
        items = nextItems
        buttons.forEach { $0.removeFromSuperview() }
        buttons = nextItems.map { item in
            let button = TabItemButton(item: item)
            button.addAction(UIAction { [weak self] _ in
                self?.handleSelect(item.id)
            }, for: .touchUpInside)
            stack.addArrangedSubview(button)
            return button
        }
    }

    private func handleSelect(_ id: String) {
        if selectedId != id {
            selectedId = id
            previewId = id
            selectionFeedback.selectionChanged()
            selectionFeedback.prepare()
            refreshSelection()
            updatePill(animated: true)
        }
        if !applying {
            delegate?.tabBarView(self, didSelectTab: id)
        }
    }

    private func refreshSelection() {
        let selectedColor = accentColor ?? (appearanceIsDark ? UIColor.white : UIColor.black)
        let muted = appearanceIsDark
            ? UIColor.white.withAlphaComponent(0.62)
            : UIColor.black.withAlphaComponent(0.48)
        let activeId = previewId.isEmpty ? selectedId : previewId
        for button in buttons {
            button.apply(
                selected: button.item.id == activeId,
                selectedColor: selectedColor,
                mutedColor: muted
            )
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let translation = pan.translation(in: glass)
        let velocity = pan.velocity(in: glass)
        let dx = abs(translation.x) + abs(velocity.x)
        let dy = abs(translation.y) + abs(velocity.y)
        // Horizontal scrub only. Up/down must not morph the glass pill.
        return dx > dy
    }

    @objc private func handlePan(_ pan: UIPanGestureRecognizer) {
        let translation = pan.translation(in: glass.contentView)
        switch pan.state {
        case .began:
            isPanning = true
            panStartFrame = pillFrame(for: selectedId)
            selectionGlass.frame = panStartFrame
        case .changed:
            let stretch = min(28, abs(translation.x) * 0.22)
            var frame = panStartFrame.insetBy(dx: -stretch / 2, dy: 0)
            frame.origin.x += translation.x
            selectionGlass.frame = clampPill(frame)
            let nextId = nearestId(at: selectionGlass.frame.midX)
            if nextId != previewId {
                previewId = nextId
                selectionFeedback.selectionChanged()
                selectionFeedback.prepare()
                refreshSelection()
            }
        case .ended:
            isPanning = false
            let commitId = nearestId(at: selectionGlass.frame.midX)
            if commitId != selectedId {
                handleSelect(commitId)
            } else {
                previewId = selectedId
                refreshSelection()
                updatePill(animated: true)
            }
        case .cancelled, .failed:
            isPanning = false
            previewId = selectedId
            refreshSelection()
            updatePill(animated: true)
        default:
            break
        }
    }

    private func updatePill(animated: Bool) {
        let frame = pillFrame(for: selectedId)
        guard frame.width > 1 else { return }
        selectionGlass.setCornerRadius(frame.height / 2)
        let updates = { self.selectionGlass.frame = frame }
        if animated {
            UIView.animate(
                withDuration: 0.28,
                delay: 0,
                usingSpringWithDamping: 0.86,
                initialSpringVelocity: 0.4,
                options: [.allowUserInteraction, .beginFromCurrentState],
                animations: updates
            )
        } else {
            updates()
        }
    }

    private func pillFrame(for id: String) -> CGRect {
        guard let button = buttons.first(where: { $0.item.id == id }) ?? buttons.first else {
            return .zero
        }
        return button.convert(button.bounds, to: glass.contentView)
    }

    private func clampPill(_ frame: CGRect) -> CGRect {
        let bounds = stack.frame
        guard bounds.width > 1 else { return frame }
        var next = frame
        if next.minX < bounds.minX { next.origin.x = bounds.minX }
        if next.maxX > bounds.maxX { next.origin.x = bounds.maxX - next.width }
        return next
    }

    private func nearestId(at x: CGFloat) -> String {
        var best = selectedId
        var bestDistance = CGFloat.greatestFiniteMagnitude
        for button in buttons {
            let mid = button.convert(button.bounds, to: glass.contentView).midX
            let distance = abs(mid - x)
            if distance < bestDistance {
                bestDistance = distance
                best = button.item.id
            }
        }
        return best
    }

    private static func parseHex(_ raw: String) -> UIColor? {
        var hex = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        let r = CGFloat((value >> 16) & 0xFF) / 255
        let g = CGFloat((value >> 8) & 0xFF) / 255
        let b = CGFloat(value & 0xFF) / 255
        return UIColor(red: r, green: g, blue: b, alpha: 1)
    }
}

private final class TabItemButton: UIButton {
    let item: OpenChamberTabBarItem
    private let iconView = UIImageView()
    private let nameLabel = UILabel()

    init(item: OpenChamberTabBarItem) {
        self.item = item
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        isAccessibilityElement = true
        accessibilityLabel = item.label
        accessibilityTraits = .button
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.contentMode = .scaleAspectFit
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.text = item.label
        nameLabel.textAlignment = .center
        nameLabel.numberOfLines = 1
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.adjustsFontSizeToFitWidth = true
        nameLabel.minimumScaleFactor = 0.75
        addSubview(iconView)
        addSubview(nameLabel)
        NSLayoutConstraint.activate([
            iconView.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            iconView.centerXAnchor.constraint(equalTo: centerXAnchor),
            iconView.widthAnchor.constraint(equalToConstant: 23),
            iconView.heightAnchor.constraint(equalToConstant: 23),
            nameLabel.topAnchor.constraint(equalTo: iconView.bottomAnchor, constant: 3),
            nameLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            nameLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
            nameLabel.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -4),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isHighlighted: Bool {
        didSet {
            let scale: CGFloat = isHighlighted ? 0.985 : 1
            UIView.animate(withDuration: 0.1, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState]) {
                self.transform = CGAffineTransform(scaleX: scale, y: scale)
            }
        }
    }

    func apply(selected: Bool, selectedColor: UIColor, mutedColor: UIColor) {
        accessibilityTraits = selected ? [.button, .selected] : .button
        let config = UIImage.SymbolConfiguration(pointSize: 18, weight: selected ? .semibold : .medium)
        let preferred = selected ? item.selectedSymbol : item.symbol
        let image = UIImage(systemName: preferred, withConfiguration: config)
            ?? UIImage(systemName: item.symbol, withConfiguration: config)
        iconView.image = image?.withRenderingMode(.alwaysTemplate)
        nameLabel.font = .systemFont(ofSize: 12, weight: selected ? .semibold : .medium)
        let color = selected ? selectedColor : mutedColor
        iconView.tintColor = color
        nameLabel.textColor = color
    }
}

private final class TabBarGlassBackdropView: UIView {
    var appearanceIsDark = true { didSet { refreshEffect() } }

    private let blurView = UIVisualEffectView(effect: nil)
    // Interactive UIGlassEffect samples touches through its own contentView.
    var contentView: UIView { blurView.contentView }

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        layer.cornerCurve = .continuous
        clipsToBounds = false
        blurView.translatesAutoresizingMaskIntoConstraints = false
        blurView.layer.cornerCurve = .continuous
        blurView.clipsToBounds = true
        addSubview(blurView)
        NSLayoutConstraint.activate([
            blurView.topAnchor.constraint(equalTo: topAnchor),
            blurView.bottomAnchor.constraint(equalTo: bottomAnchor),
            blurView.leadingAnchor.constraint(equalTo: leadingAnchor),
            blurView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        refreshEffect()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setCornerRadius(_ radius: CGFloat) {
        layer.cornerRadius = radius
        blurView.layer.cornerRadius = radius
        refreshHoverStyle()
    }

    func refreshEffect() {
        if let glass = Self.makeGlassEffect() {
            blurView.effect = glass
            backgroundColor = .clear
            layer.borderWidth = 0
            blurView.layer.borderWidth = 0
            refreshHoverStyle()
            return
        }
        let style: UIBlurEffect.Style = appearanceIsDark ? .systemUltraThinMaterialDark : .systemUltraThinMaterialLight
        blurView.effect = UIBlurEffect(style: style)
        backgroundColor = .clear
        blurView.backgroundColor = appearanceIsDark
            ? UIColor.black.withAlphaComponent(0.18)
            : UIColor.white.withAlphaComponent(0.22)
        blurView.layer.borderWidth = 0.5
        blurView.layer.borderColor = (appearanceIsDark
            ? UIColor.white.withAlphaComponent(0.16)
            : UIColor.white.withAlphaComponent(0.55)).cgColor
        refreshHoverStyle()
    }

    private func refreshHoverStyle() {
        guard #available(iOS 17.0, *) else { return }
        let shape = UIShape.rect(cornerRadius: layer.cornerRadius, cornerCurve: .continuous)
        hoverStyle = UIHoverStyle(effect: .lift, shape: shape)
        blurView.hoverStyle = UIHoverStyle(effect: .highlight, shape: shape)
    }

    private static func makeGlassEffect() -> UIVisualEffect? {
        if #available(iOS 26.0, *) {
            let glass = UIGlassEffect(style: .regular)
            glass.isInteractive = true
            return glass
        }
        guard let effectClass = NSClassFromString("UIGlassEffect") as? NSObject.Type else {
            return nil
        }
        let effect = effectClass.init()
        if effect.responds(to: NSSelectorFromString("setInteractive:")) {
            effect.setValue(true, forKey: "interactive")
        }
        return effect as? UIVisualEffect
    }
}
