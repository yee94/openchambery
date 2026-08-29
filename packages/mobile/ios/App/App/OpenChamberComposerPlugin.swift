import Capacitor
import UIKit

@objc(OpenChamberComposerPlugin)
class OpenChamberComposerPlugin: CAPPlugin, CAPBridgedPlugin, OpenChamberComposerViewDelegate {
    let identifier = "OpenChamberComposerPlugin"
    let jsName = "OpenChamberComposer"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSuppressed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "focus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "blur", returnType: CAPPluginReturnPromise),
    ]

    private weak var composerView: OpenChamberComposerView?
    private var bottomConstraint: NSLayoutConstraint?
    private var lastReportedHeight: CGFloat = -1

    @objc func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("OpenChamberComposer plugin deallocated")
                return
            }
            guard self.installIfNeeded() else {
                call.reject("OpenChamberComposer host view unavailable")
                return
            }
            self.apply(call)
            self.composerView?.isHidden = false
            self.reportHeight()
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("OpenChamberComposer plugin deallocated")
                return
            }
            guard self.composerView != nil || self.installIfNeeded() else {
                call.reject("OpenChamberComposer host view unavailable")
                return
            }
            self.apply(call)
            self.reportHeight()
            call.resolve()
        }
    }

    @objc func dismiss(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.tearDown()
            call.resolve()
        }
    }

    @objc func setSuppressed(_ call: CAPPluginCall) {
        let suppressed = call.getBool("suppressed") ?? false
        DispatchQueue.main.async { [weak self] in
            self?.composerView?.setSuppressed(suppressed)
            self?.reportHeight()
            call.resolve()
        }
    }

    @objc func focus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.composerView?.focusInput()
            call.resolve()
        }
    }

    @objc func blur(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.composerView?.blurInput()
            call.resolve()
        }
    }

    func composerViewDidChangeText(_ view: OpenChamberComposerView, text: String) {
        notifyListeners("textChanged", data: ["text": text])
    }

    func composerViewDidRequestSend(_ view: OpenChamberComposerView, text: String) {
        notifyListeners("send", data: ["text": text])
    }

    func composerViewDidRequestAbort(_ view: OpenChamberComposerView) {
        notifyListeners("abort", data: [:])
    }

    func composerViewDidRequestAttach(_ view: OpenChamberComposerView) {
        notifyListeners("attach", data: [:])
    }

    func composerViewDidRequestModel(_ view: OpenChamberComposerView) {
        notifyListeners("openModel", data: [:])
    }

    func composerViewDidChangeExpanded(_ view: OpenChamberComposerView, expanded: Bool) {
        notifyListeners("expandedChanged", data: ["expanded": expanded])
    }

    func composerViewDidChangeHeight(_ view: OpenChamberComposerView) {
        reportHeight()
    }

    @discardableResult
    private func installIfNeeded() -> Bool {
        if composerView != nil { return true }
        guard let host = bridge?.viewController?.view else { return false }
        let composer = OpenChamberComposerView()
        composer.delegate = self
        host.addSubview(composer)

        let bottom: NSLayoutConstraint
        if #available(iOS 15.0, *) {
            bottom = composer.bottomAnchor.constraint(
                equalTo: host.keyboardLayoutGuide.topAnchor,
                constant: -10
            )
        } else {
            bottom = composer.bottomAnchor.constraint(
                equalTo: host.safeAreaLayoutGuide.bottomAnchor,
                constant: -10
            )
        }
        bottomConstraint = bottom
        NSLayoutConstraint.activate([
            composer.leadingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            composer.trailingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            bottom,
        ])
        composerView = composer
        return true
    }

    private func apply(_ call: CAPPluginCall) {
        composerView?.applyState(
            text: call.getString("text"),
            placeholder: call.getString("placeholder"),
            modelLabel: call.getString("modelLabel"),
            canSend: call.getBool("canSend") ?? false,
            canAbort: call.getBool("canAbort") ?? false,
            attachmentCount: call.getInt("attachmentCount") ?? 0,
            appearance: call.getString("appearance"),
            attachAria: call.getString("attachAria"),
            sendAria: call.getString("sendAria"),
            stopAria: call.getString("stopAria"),
            modelAria: call.getString("modelAria")
        )
        if let suppressed = call.getBool("suppressed") {
            composerView?.setSuppressed(suppressed)
        }
    }

    private func tearDown() {
        composerView?.blurInput()
        composerView?.removeFromSuperview()
        composerView = nil
        bottomConstraint = nil
        lastReportedHeight = -1
        notifyListeners("heightChanged", data: ["height": 0])
    }

    private func reportHeight() {
        guard let composer = composerView, let host = composer.superview, !composer.isHidden else {
            if lastReportedHeight != 0 {
                lastReportedHeight = 0
                notifyListeners("heightChanged", data: ["height": 0])
            }
            return
        }
        host.layoutIfNeeded()
        let inset = max(0, host.bounds.maxY - composer.frame.minY)
        let rounded = (inset * 100).rounded() / 100
        guard abs(rounded - lastReportedHeight) > 0.5 else { return }
        lastReportedHeight = rounded
        notifyListeners("heightChanged", data: ["height": rounded])
    }
}
