import UIKit
import WebKit

protocol YuriTabBarViewDelegate: AnyObject {
    func tabBarView(_ view: YuriTabBarView, didSelectTab id: String)
    func tabBarViewDidChangeHeight(_ view: YuriTabBarView)
}

struct YuriTabBarItem {
    let id: String
    let label: String
    let symbol: String
    let selectedSymbol: String
    /// Display string from UI (`"4"`, `"99+"`). `nil` / empty clears `badgeValue`.
    let badge: String?
    /// Spinner badge. UI sends this only when `badge` is nil.
    let activity: Bool
    let activityLabel: String?
    let avatar: String?
}

/// Full-screen pass-through host for a chrome-only `UITabBarController`.
///
/// iOS 26 paints the floating liquid-glass capsule and selected liquid lens
/// only when a tab bar is owned by a tab controller. This overlay never
/// hosts real pages — placeholder controllers stay clear, taps emit
/// `tabSelected`, and React still owns the homepage stack.
/// Light and dark follow the Web theme via `overrideUserInterfaceStyle`.
final class YuriTabBarView: UIView, UITabBarControllerDelegate {
    weak var delegate: YuriTabBarViewDelegate?

    static var supportsLiquidGlass: Bool {
        if #available(iOS 26.0, *) { return true }
        return NSClassFromString("UIGlassEffect") != nil
    }

    /// Item row only. The controller extends the bar through the home indicator.
    static let dockHeight: CGFloat = 49

    let chromeController = YuriTabBarChromeController()

    private var items: [YuriTabBarItem] = []
    private var activityBadges: [String: TabActivityBadge] = [:]
    private var avatarView: WKWebView?
    private var avatarURI: String?
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
        chromeController.view.layoutIfNeeded()
        layoutActivityBadges()
        layoutAvatar()
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
        items nextItems: [YuriTabBarItem],
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
        if !nextItems.isEmpty {
            if items.map(\.id) != nextItems.map(\.id) || items.map(\.label) != nextItems.map(\.label) {
                rebuild(items: nextItems)
            } else {
                // Same tab structure: push badge and loading updates without rebuilding chrome.
                items = nextItems
                applyBadges()
                applyActivity()
            }
        }
        if let nextSelectedId, !nextSelectedId.isEmpty {
            selectedId = nextSelectedId
        } else if selectedId.isEmpty {
            selectedId = nextItems.first?.id ?? ""
        }
        applySelectedItem()
        applyAvatar()
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
        chromeController.onLayout = { [weak self] in self?.layoutAvatar() }
        let tabBar = chromeController.tabBar
        // Leave system bar chrome untouched so iOS 26 can paint glass + lens.
        tabBar.isTranslucent = true
        tabBar.unselectedItemTintColor = .secondaryLabel
        if #available(iOS 17.0, *) {
            hoverStyle = nil
            tabBar.hoverStyle = nil
        }
    }

    private func rebuild(items nextItems: [YuriTabBarItem]) {
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
            page.tabBarItem.badgeValue = Self.badgeValue(item.badge)
            return page
        }
        applySelectedItem()
        applyActivity()
    }

    /// Apply UI-owned badge strings to existing items without rebuilding chrome.
    private func applyBadges() {
        guard let viewControllers = chromeController.viewControllers else { return }
        for (index, item) in items.enumerated() {
            guard index < viewControllers.count else { break }
            viewControllers[index].tabBarItem.badgeValue = Self.badgeValue(item.badge)
        }
    }

    /// Loading occupies the same corner as a count badge and never stacks with it.
    private func applyActivity() {
        let live = Set(items.map(\.id))
        for id in activityBadges.keys where !live.contains(id) {
            activityBadges[id]?.removeFromSuperview()
            activityBadges[id] = nil
        }
        guard let viewControllers = chromeController.viewControllers else { return }
        for (index, item) in items.enumerated() {
            let show = item.activity && (item.badge?.isEmpty ?? true)
            let badge = activityBadge(for: item.id)
            badge.isHidden = !show
            if show {
                badge.spinner.startAnimating()
            } else {
                badge.spinner.stopAnimating()
            }
            guard index < viewControllers.count else { continue }
            viewControllers[index].tabBarItem.accessibilityValue = show ? item.activityLabel : nil
        }
        setNeedsLayout()
    }

    private func activityBadge(for id: String) -> TabActivityBadge {
        if let existing = activityBadges[id] { return existing }
        let badge = TabActivityBadge()
        addSubview(badge)
        activityBadges[id] = badge
        return badge
    }

    private func applyAvatar() {
        guard let index = items.firstIndex(where: { $0.id == "assistant" }),
              let controllers = chromeController.viewControllers, index < controllers.count else {
            avatarView?.removeFromSuperview()
            avatarView = nil
            avatarURI = nil
            return
        }
        let item = items[index]
        let uri = item.avatar.flatMap { value in
            value.hasPrefix("data:image/svg+xml;charset=utf-8,") ? value : nil
        }
        guard let tab = controllers[index].tabBarItem else { return }
        guard let uri else {
            avatarView?.removeFromSuperview()
            avatarView = nil
            avatarURI = nil
            tab.image = UIImage(systemName: item.symbol)
            tab.selectedImage = UIImage(systemName: item.selectedSymbol)
            return
        }
        let blank = UIGraphicsImageRenderer(size: CGSize(width: 23, height: 23)).image { _ in }
            .withRenderingMode(.alwaysOriginal)
        tab.image = blank
        tab.selectedImage = blank
        if avatarView == nil {
            let configuration = WKWebViewConfiguration()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.isOpaque = false
            view.backgroundColor = .clear
            view.scrollView.backgroundColor = .clear
            view.scrollView.isScrollEnabled = false
            view.scrollView.contentInsetAdjustmentBehavior = .never
            view.isUserInteractionEnabled = false
            view.isAccessibilityElement = false
            addSubview(view)
            avatarView = view
        }
        if avatarURI != uri {
            avatarURI = uri
            let escaped = uri.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "\"", with: "&quot;")
                .replacingOccurrences(of: "<", with: "&lt;")
            avatarView?.loadHTMLString("""
                <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
                <style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:28.75px;height:28.75px;border-radius:25%}</style>
                <img src="\(escaped)">
                """, baseURL: nil)
        }
        setNeedsLayout()
    }

    private func layoutAvatar() {
        guard let avatarView,
              let index = items.firstIndex(where: { $0.id == "assistant" }),
              let controllers = chromeController.viewControllers, index < controllers.count,
              let image = controllers[index].tabBarItem.image else { return }
        // iOS 26 nests tab icons inside the glass platter. Match our placeholder
        // instead of relying on private button class names or equal-width slots.
        guard let icon = iconImageView(in: chromeController.tabBar, matching: image) else {
            avatarView.isHidden = true
            return
        }
        let frame = icon.convert(icon.bounds, to: self)
        avatarView.bounds = CGRect(x: 0, y: 0, width: 28.75, height: 28.75)
        avatarView.center = CGPoint(x: frame.midX, y: frame.midY)
        avatarView.isHidden = false
        for badge in activityBadges.values { bringSubviewToFront(badge) }
    }

    private func iconImageView(in view: UIView, matching image: UIImage) -> UIImageView? {
        if let icon = view as? UIImageView, icon.image === image, !icon.bounds.isEmpty { return icon }
        for child in view.subviews {
            if let icon = iconImageView(in: child, matching: image) { return icon }
        }
        return nil
    }

    private func layoutActivityBadges() {
        let frames = tabButtonFrames()
        for (index, item) in items.enumerated() {
            guard let badge = activityBadges[item.id], !badge.isHidden, index < frames.count else { continue }
            let frame = frames[index]
            badge.bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
            badge.center = CGPoint(x: frame.midX + 14, y: frame.minY + 12)
        }
    }

    private func tabButtonFrames() -> [CGRect] {
        let tabBar = chromeController.tabBar
        let buttons = tabBar.subviews
            .filter { String(describing: type(of: $0)).contains("TabBarButton") && !$0.frame.isEmpty }
            .sorted { $0.frame.minX < $1.frame.minX }
        if buttons.count == items.count {
            return buttons.map { $0.convert($0.bounds, to: self) }
        }
        let barFrame = tabBar.convert(tabBar.bounds, to: self)
        guard barFrame.width > 0, !items.isEmpty else { return [] }
        let width = barFrame.width / CGFloat(items.count)
        let height = min(49, barFrame.height)
        return items.indices.map { index in
            CGRect(x: barFrame.minX + width * CGFloat(index), y: barFrame.minY, width: width, height: height)
        }
    }

    /// `nil` / empty clears the system badge; non-empty uses the UI display string as-is.
    private static func badgeValue(_ badge: String?) -> String? {
        guard let badge, !badge.isEmpty else { return nil }
        return badge
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

/// Inverse 18pt corner badge matching the web dock loading mark.
private final class TabActivityBadge: UIView {
    let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: CGRect(x: 0, y: 0, width: 18, height: 18))
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        isHidden = true
        backgroundColor = .label
        layer.cornerRadius = 9
        clipsToBounds = true
        spinner.color = .systemBackground
        spinner.hidesWhenStopped = true
        spinner.transform = CGAffineTransform(scaleX: 0.55, y: 0.55)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

/// Keeps the controller view clear so the WebView remains visible.
/// Pages stay empty; only the system tab bar is meant to paint.
final class YuriTabBarChromeController: UITabBarController {
    var onLayout: (() -> Void)?

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        onLayout?()
    }

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
