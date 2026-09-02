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

/// Full-screen pass-through host for a chrome-only `UITabBarController`.
///
/// iOS 26 paints the floating liquid-glass capsule and selected liquid lens
/// only when a tab bar is owned by a tab controller. This overlay never
/// hosts real pages — placeholder controllers stay clear, taps emit
/// `tabSelected`, and React still owns the homepage stack.
/// Light and dark follow the Web theme via `overrideUserInterfaceStyle`.
final class OpenChamberTabBarView: UIView, UITabBarControllerDelegate {
    weak var delegate: OpenChamberTabBarViewDelegate?

    static var supportsLiquidGlass: Bool {
        if #available(iOS 26.0, *) { return true }
        return NSClassFromString("UIGlassEffect") != nil
    }

    /// Item row only. The controller extends the bar through the home indicator.
    static let dockHeight: CGFloat = 49

    let chromeController = OpenChamberTabBarChromeController()

    private var items: [OpenChamberTabBarItem] = []
    private var selectedId = ""
    private var applying = false
    private var lastReportedHeight: CGFloat = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        isOpaque = false
        backgroundColor = .clear
        clipsToBounds = false
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let tabPoint = convert(point, to: chromeController.tabBar)
        return chromeController.tabBar.point(inside: tabPoint, with: event)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        reportHeightIfNeeded()
    }

    func attachChrome(to parent: UIViewController) {
        guard chromeController.parent !== parent else { return }
        if chromeController.parent != nil {
            chromeController.willMove(toParent: nil)
            chromeController.view.removeFromSuperview()
            chromeController.removeFromParent()
        }
        parent.addChild(chromeController)
        addSubview(chromeController.view)
        chromeController.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            chromeController.view.topAnchor.constraint(equalTo: topAnchor),
            chromeController.view.bottomAnchor.constraint(equalTo: bottomAnchor),
            chromeController.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            chromeController.view.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        chromeController.didMove(toParent: parent)
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
            applyAppearance(appearance)
        }
        if let nextAccent {
            applyAccent(nextAccent)
        }
        if let ariaLabel, !ariaLabel.isEmpty {
            accessibilityLabel = ariaLabel
            chromeController.tabBar.accessibilityLabel = ariaLabel
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
        applySelectedItem()
        applying = false
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        guard let id = viewController.tabBarItem.accessibilityIdentifier, !id.isEmpty else { return }
        selectedId = id
        if !applying {
            delegate?.tabBarView(self, didSelectTab: id)
        }
    }

    private func build() {
        isAccessibilityElement = false
        accessibilityContainerType = .semanticGroup
        chromeController.delegate = self
        let tabBar = chromeController.tabBar
        // Leave system bar chrome untouched so iOS 26 can paint glass + lens.
        tabBar.isTranslucent = true
        tabBar.unselectedItemTintColor = .secondaryLabel
        if #available(iOS 17.0, *) {
            hoverStyle = nil
            tabBar.hoverStyle = nil
        }
    }

    private func rebuild(items nextItems: [OpenChamberTabBarItem]) {
        items = nextItems
        chromeController.viewControllers = nextItems.map { item in
            let page = UIViewController()
            page.view.backgroundColor = .clear
            page.view.isOpaque = false
            page.view.isUserInteractionEnabled = false
            page.view.alpha = 0
            page.tabBarItem = UITabBarItem(
                title: item.label,
                image: UIImage(systemName: item.symbol),
                selectedImage: UIImage(systemName: item.selectedSymbol)
            )
            page.tabBarItem.accessibilityIdentifier = item.id
            page.tabBarItem.accessibilityLabel = item.label
            return page
        }
        applySelectedItem()
    }

    private func applySelectedItem() {
        guard let match = chromeController.viewControllers?.first(where: {
            $0.tabBarItem.accessibilityIdentifier == selectedId
        }) ?? chromeController.viewControllers?.first else { return }
        chromeController.selectedViewController = match
    }

    /// Web theme is the source of truth so a light app on a dark system
    /// (and the reverse) still gets the matching liquid-glass recipe.
    private func applyAppearance(_ appearance: String) {
        let style: UIUserInterfaceStyle = appearance == "light" ? .light : .dark
        overrideUserInterfaceStyle = style
        chromeController.overrideUserInterfaceStyle = style
        chromeController.tabBar.overrideUserInterfaceStyle = style
    }

    private func applyAccent(_ raw: String) {
        chromeController.tabBar.tintColor = Self.parseHex(raw) ?? .label
    }

    private func reportHeightIfNeeded() {
        let height = chromeController.tabBar.bounds.height
        guard height > 0, height != lastReportedHeight else {
            delegate?.tabBarViewDidChangeHeight(self)
            return
        }
        lastReportedHeight = height
        delegate?.tabBarViewDidChangeHeight(self)
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

/// Keeps the controller view clear so the WebView remains visible.
/// Pages stay empty; only the system tab bar is meant to paint.
final class OpenChamberTabBarChromeController: UITabBarController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.isOpaque = false
        for subview in view.subviews where subview !== tabBar {
            subview.backgroundColor = .clear
            subview.isOpaque = false
        }
    }
}
