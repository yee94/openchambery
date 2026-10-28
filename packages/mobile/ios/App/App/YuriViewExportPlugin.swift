import Capacitor
import UIKit
import WebKit

@objc(YuriViewExportPlugin)
final class YuriViewExportPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    let identifier = "YuriViewExportPlugin"
    let jsName = "YuriViewExport"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportPDF", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportLongImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private var activeCall: CAPPluginCall?
    private var taskId: String?
    private var renderer: YuriViewExportRenderer?
    private var directory: URL?
    private var picker: UIDocumentPickerViewController?
    private var ownerLoading: NSKeyValueObservation?
    private var terminating = false

    @objc func capabilities(_ call: CAPPluginCall) {
        call.resolve(["version": 1, "exportPDF": true, "exportLongImage": true, "limits": YuriViewExportRequest.limits])
    }

    @objc func exportPDF(_ call: CAPPluginCall) { start(call, pdf: true) }
    @objc func exportLongImage(_ call: CAPPluginCall) { start(call, pdf: false) }

    private func start(_ call: CAPPluginCall, pdf: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("Export owner unavailable", "EXPORT_ABORTED"); return }
            guard self.activeCall == nil else { call.reject("An export is already active", "EXPORT_BUSY"); return }
            let request: YuriViewExportRequest
            do {
                guard let input = call.options as? [String: Any] else {
                    throw YuriViewExportError(code: "EXPORT_INVALID_INPUT", message: "Invalid export input")
                }
                request = try YuriViewExportRequest(input, pdf: pdf)
            }
            catch let error as YuriViewExportError { call.reject(error.message, error.code); return }
            catch { call.reject("Invalid export input", "EXPORT_INVALID_INPUT"); return }
            guard let presenter = self.bridge?.viewController, presenter.view.window != nil,
                  presenter.presentedViewController == nil else {
                call.reject("Save presenter is unavailable", "EXPORT_SAVE_FAILED"); return
            }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("yuri-view-export-" + UUID().uuidString, isDirectory: true)
            do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false) }
            catch { call.reject("Could not create export file", "EXPORT_SAVE_FAILED"); return }
            self.activeCall = call
            self.taskId = request.taskId
            self.directory = directory
            self.bridge?.saveCall(call)
            // Reloading/navigating the owning app invalidates its pending task.
            self.ownerLoading = self.webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
                if change.newValue == true {
                    DispatchQueue.main.async {
                        guard self?.activeCall === call else { return }
                        self?.finish(status: "cancelled")
                    }
                }
            }
            let renderer = YuriViewExportRenderer(request: request, directory: directory, progress: { [weak self] stage, completed, total in
                guard let self, self.taskId == request.taskId, !self.terminating else { return }
                var event: [String: Any] = ["taskId": request.taskId, "stage": stage]
                if let completed { event["completed"] = completed }
                if let total { event["total"] = total }
                self.notifyListeners("progress", data: event)
            }, completion: { [weak self] result in
                guard let self, self.taskId == request.taskId, !self.terminating else { return }
                switch result {
                case .success(let url): self.presentSave(url)
                case .failure(let error): self.finish(error: error)
                }
            })
            self.renderer = renderer
            renderer.start(in: presenter.view)
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("taskId"), !id.isEmpty else {
            call.reject("taskId is required", "EXPORT_INVALID_INPUT"); return
        }
        DispatchQueue.main.async { [weak self] in
            if self?.taskId == id { self?.finish(status: "cancelled") }
            call.resolve()
        }
    }

    private func presentSave(_ url: URL) {
        guard let call = activeCall, let presenter = bridge?.viewController, presenter.view.window != nil,
              presenter.presentedViewController == nil else {
            finish(error: YuriViewExportError(code: "EXPORT_SAVE_FAILED", message: "Save presenter is unavailable")); return
        }
        renderer = nil
        notifyListeners("progress", data: ["taskId": taskId!, "stage": "saving"])
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        // The document-provider initializer can spin a nested run loop. An abort
        // or owner navigation during it must not present an orphaned picker.
        guard activeCall === call, !terminating else { return }
        self.picker = picker
        picker.shouldShowFileExtensions = true
        picker.delegate = self
        picker.presentationController?.delegate = self
        presenter.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker else { return }
        if urls.isEmpty {
            finish(error: YuriViewExportError(code: "EXPORT_SAVE_FAILED", message: "Document provider did not save the export"))
        } else {
            // Export-as-copy's delegate fires after the provider completes copying.
            finish(status: "saved")
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if controller === picker { finish(status: "cancelled") }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if presentationController.presentedViewController === picker { finish(status: "cancelled") }
    }

    private func finish(status: String = "cancelled", error: YuriViewExportError? = nil) {
        guard let call = activeCall, !terminating else { return }
        terminating = true
        ownerLoading?.invalidate()
        ownerLoading = nil
        let cleanup = { [weak self] in
            guard let self else { return }
            if let directory = self.directory { try? FileManager.default.removeItem(at: directory) }
            self.directory = nil
            self.picker = nil
            self.activeCall = nil
            self.taskId = nil
            self.terminating = false
            if let error { call.reject(error.message, error.code) } else { call.resolve(["status": status]) }
            self.bridge?.releaseCall(call)
        }
        let finishSaving = { [weak self] in
            guard let self else { return }
            self.renderer = nil
            if let picker = self.picker, picker.presentingViewController != nil {
                picker.delegate = nil
                picker.dismiss(animated: true, completion: cleanup)
            } else { cleanup() }
        }
        if let renderer { renderer.cancel(completion: finishSaving) } else { finishSaving() }
    }

    deinit {
        let renderer = renderer, directory = directory, picker = picker, call = activeCall, bridge = bridge
        ownerLoading?.invalidate()
        DispatchQueue.main.async {
            renderer?.cancel()
            picker?.delegate = nil
            picker?.dismiss(animated: false)
            if let directory { try? FileManager.default.removeItem(at: directory) }
            call?.resolve(["status": "cancelled"])
            if let call { bridge?.releaseCall(call) }
        }
    }
}
