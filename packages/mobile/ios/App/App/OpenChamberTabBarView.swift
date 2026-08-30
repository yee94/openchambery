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
final class OpenChamberTabBarView: UIView {
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
    private let stack = UIStackView()
    private let selectionFeedback = UISelectionFeedbackGenerator()
    private var buttons: [TabItemButton] = []
    private var items: [OpenChamberTabBarItem] = []
    private var selectedId = ""
    private var appearanceIsDark = true
    private var applying = false

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
        delegate?.tabBarViewDidChangeHeight(self)
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: Self.dockHeight)
    }

    func apply(
        items nextItems: [OpenChamberTabBarItem],
        selectedId nextSelectedId: String?,
        appearance: String?,
        ariaLabel: String?
    ) {
        applying = true
        if let appearance {
            appearanceIsDark = appearance == "dark"
            glass.appearanceIsDark = appearanceIsDark
            overrideUserInterfaceStyle = appearanceIsDark ? .dark : .light
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
        refreshSelection(animated: false)
        applying = false
    }

    private func build() {
        isAccessibilityElement = false
        accessibilityContainerType = .semanticGroup
        glass.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        stack.axis = .horizontal
        stack.alignment = .fill
        stack.distribution = .fillEqually
        stack.spacing = 3
        stack.translatesAutoresizingMaskIntoConstraints = false
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
            selectionFeedback.selectionChanged()
            selectionFeedback.prepare()
            refreshSelection(animated: true)
        }
        if !applying {
            delegate?.tabBarView(self, didSelectTab: id)
        }
    }

    private func refreshSelection(animated: Bool) {
        let updates = {
            for button in self.buttons {
                button.apply(
                    selected: button.item.id == self.selectedId,
                    appearanceIsDark: self.appearanceIsDark
                )
            }
        }
        if animated {
            UIView.animate(
                withDuration: 0.12,
                delay: 0,
                options: [.curveEaseOut, .allowUserInteraction],
                animations: updates
            )
        } else {
            updates()
        }
    }
}

private final class TabItemButton: UIButton {
    let item: OpenChamberTabBarItem
    private let selectionView = UIView()
    private let iconView = UIImageView()
    private let nameLabel = UILabel()

    init(item: OpenChamberTabBarItem) {
        self.item = item
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        isAccessibilityElement = true
        accessibilityLabel = item.label
        accessibilityTraits = .button
        selectionView.translatesAutoresizingMaskIntoConstraints = false
        selectionView.isUserInteractionEnabled = false
        selectionView.layer.cornerCurve = .continuous
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.contentMode = .scaleAspectFit
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.text = item.label
        nameLabel.textAlignment = .center
        nameLabel.numberOfLines = 1
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.adjustsFontSizeToFitWidth = true
        nameLabel.minimumScaleFactor = 0.75
        addSubview(selectionView)
        addSubview(iconView)
        addSubview(nameLabel)
        NSLayoutConstraint.activate([
            selectionView.topAnchor.constraint(equalTo: topAnchor),
            selectionView.bottomAnchor.constraint(equalTo: bottomAnchor),
            selectionView.leadingAnchor.constraint(equalTo: leadingAnchor),
            selectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
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

    override func layoutSubviews() {
        super.layoutSubviews()
        selectionView.layer.cornerRadius = bounds.height / 2
    }

    override var isHighlighted: Bool {
        didSet {
            let scale: CGFloat = isHighlighted ? 0.985 : 1
            UIView.animate(withDuration: 0.1, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState]) {
                self.transform = CGAffineTransform(scaleX: scale, y: scale)
            }
        }
    }

    func apply(selected: Bool, appearanceIsDark: Bool) {
        accessibilityTraits = selected ? [.button, .selected] : .button
        let symbol = selected ? item.selectedSymbol : item.symbol
        let config = UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)
        iconView.image = UIImage(systemName: symbol, withConfiguration: config)?.withRenderingMode(.alwaysTemplate)
        nameLabel.font = .systemFont(ofSize: 12, weight: selected ? .semibold : .medium)
        let color: UIColor = selected
            ? (appearanceIsDark ? UIColor.white : UIColor.black)
            : (appearanceIsDark ? UIColor.white.withAlphaComponent(0.62) : UIColor.black.withAlphaComponent(0.48))
        iconView.tintColor = color
        nameLabel.textColor = color
        selectionView.backgroundColor = appearanceIsDark
            ? UIColor.white.withAlphaComponent(0.16)
            : UIColor.black.withAlphaComponent(0.08)
        selectionView.alpha = selected ? 1 : 0
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
