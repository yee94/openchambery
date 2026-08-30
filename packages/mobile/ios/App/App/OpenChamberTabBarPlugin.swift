import Capacitor
import UIKit

@objc(OpenChamberTabBarPlugin)
class OpenChamberTabBarPlugin: CAPPlugin, CAPBridgedPlugin, OpenChamberTabBarViewDelegate {
    let identifier = "OpenChamberTabBarPlugin"
    let jsName = "OpenChamberTabBar"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise),
    ]

    private static let allowedIds: Set<String> = ["projects", "assistant", "scheduled", "settings"]
    private static let symbols: [String: (String, String)] = [
        "projects": ("folder", "folder.fill"),
        "assistant": ("sparkles", "sparkles"),
        "scheduled": ("calendar", "calendar"),
        "settings": ("gearshape", "gearshape.fill"),
    ]

    private weak var tabBarView: OpenChamberTabBarView?
    private var lastReportedHeight: CGFloat = -1
    private var glassSupported: Bool?

    @objc func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("OpenChamberTabBar plugin deallocated")
                return
            }
            guard self.resolveGlassSupported() else {
                call.resolve(["adopted": false])
                return
            }
            guard self.installIfNeeded() else {
                call.reject("OpenChamberTabBar host view unavailable")
                return
            }
            self.apply(call)
            self.tabBarView?.isHidden = false
            self.reportHeight()
            call.resolve(["adopted": true])
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("OpenChamberTabBar plugin deallocated")
                return
            }
            guard self.resolveGlassSupported() else {
                call.resolve(["adopted": false])
                return
            }
            guard self.tabBarView != nil || self.installIfNeeded() else {
                call.reject("OpenChamberTabBar host view unavailable")
                return
            }
            self.apply(call)
            self.reportHeight()
            call.resolve(["adopted": true])
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.hideOverlay()
            call.resolve()
        }
    }

    @objc func dismiss(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.hideOverlay()
            call.resolve()
        }
    }

    func tabBarView(_ view: OpenChamberTabBarView, didSelectTab id: String) {
        notifyListeners("tabSelected", data: ["tab": id])
    }

    func tabBarViewDidChangeHeight(_ view: OpenChamberTabBarView) {
        reportHeight()
    }

    @discardableResult
    private func installIfNeeded() -> Bool {
        if tabBarView != nil { return true }
        guard resolveGlassSupported() else { return false }
        guard let hostVC = bridge?.viewController, let host = hostVC.view else { return false }
        let bar = OpenChamberTabBarView()
        bar.delegate = self
        if let webView {
            host.insertSubview(bar, aboveSubview: webView)
        } else {
            host.addSubview(bar)
        }
        bar.attachChrome(to: hostVC)

        // Full-screen pass-through host. Only the system tab bar accepts hits.
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: host.topAnchor),
            bar.bottomAnchor.constraint(equalTo: host.bottomAnchor),
            bar.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: host.trailingAnchor),
        ])
        tabBarView = bar
        return true
    }

    private func apply(_ call: CAPPluginCall) {
        let items: [OpenChamberTabBarItem]
        if let raw = call.getArray("tabs") {
            items = Self.parseTabs(raw)
        } else {
            items = []
        }
        tabBarView?.apply(
            items: items,
            selectedId: call.getString("selectedTab"),
            appearance: call.getString("appearance"),
            ariaLabel: call.getString("ariaLabel"),
            accentColor: call.getString("accentColor")
        )
    }

    /// Visual hide only. The overlay stays installed so tab switches do not rebuild glass.
    private func hideOverlay() {
        tabBarView?.isHidden = true
        lastReportedHeight = -1
        notifyListeners("heightChanged", data: ["height": 0])
    }

    private func reportHeight() {
        let height: CGFloat
        if tabBarView?.isHidden == false {
            height = tabBarView?.chromeController.tabBar.bounds.height ?? 0
        } else {
            height = 0
        }
        guard height != lastReportedHeight else { return }
        lastReportedHeight = height
        notifyListeners("heightChanged", data: ["height": height])
    }

    private func resolveGlassSupported() -> Bool {
        if let glassSupported { return glassSupported }
        let supported = OpenChamberTabBarView.supportsLiquidGlass
        glassSupported = supported
        return supported
    }

    private static func parseTabs(_ raw: JSArray) -> [OpenChamberTabBarItem] {
        raw.compactMap { entry -> OpenChamberTabBarItem? in
            let object = (entry as? JSObject) ?? (entry as? [String: Any])
            guard let object else { return nil }
            guard let id = object["id"] as? String, allowedIds.contains(id) else { return nil }
            let label = object["label"] as? String ?? id
            guard let pair = symbols[id] else { return nil }
            return OpenChamberTabBarItem(
                id: id,
                label: label,
                symbol: pair.0,
                selectedSymbol: pair.1
            )
        }
    }
}
