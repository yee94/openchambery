import Capacitor
import UIKit

private final class ExportBridgeController: CAPBridgeViewController {
    let exporter = YuriViewExportPlugin()
    var onPicker: (() -> Void)?
    override func capacitorDidLoad() { bridge?.registerPluginInstance(exporter) }
    override func present(_ viewControllerToPresent: UIViewController, animated flag: Bool, completion: (() -> Void)? = nil) {
        super.present(viewControllerToPresent, animated: flag) {
            completion?()
            if viewControllerToPresent is UIDocumentPickerViewController { self.onPicker?() }
        }
    }
}

@main
final class ViewExportBridgeProbe: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let controller = ExportBridgeController()
    private var step = 0
    private var resolved = false
    private var stages: [String] = []
    private var initialFiles: Set<String> = []
    private var busyRejected = false
    private var encodingBusyRejected = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        initialFiles = temporaryExports()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.begin() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { self.fail("bridge probe timeout") }
        return true
    }

    private func call(_ method: String, options: [String: Any] = [:], success: @escaping ([String: Any]) -> Void = { _ in },
                      failure: ((CAPPluginCallError) -> Void)? = nil) -> CAPPluginCall {
        CAPPluginCall(callbackId: UUID().uuidString, methodName: method, options: options, success: { result, _ in
            success(result?.data ?? [:])
        }, error: { error in
            if let failure { failure(error!) } else { self.fail("unexpected error: \(error!.code ?? "none")") }
        })!
    }

    private func options(_ id: String, tall: Bool = false) -> [String: Any] {
        ["taskId": id, "snapshot": ["html": "<div style='height:100%;background:red'>snapshot</div>",
                                    "width": 600, "height": tall ? 10000 : 1000], "filename": "snapshot"]
    }

    private func begin() {
        controller.onPicker = { if self.step != 5 { self.handlePicker() } }
        controller.exporter.capabilities(call("capabilities", success: { value in
            self.require(value["version"] as? Int == 1 && value["exportPDF"] as? Bool == true
                         && value["exportLongImage"] as? Bool == true, "capability shape")
            self.require((value["limits"] as? [String: Int]) == YuriViewExportRequest.limits, "capability limits")
        }))
        controller.exporter.exportPDF(call("exportPDF", failure: { error in
            self.require(error.code == "EXPORT_INVALID_INPUT", "invalid error code")
        }))
        controller.exporter.addEventListener("progress", listener: call("progress", success: { value in
            self.require(value["taskId"] as? String == "task-\(self.step)", "uncorrelated progress")
            let stage = value["stage"] as! String
            self.stages.append(stage)
            if self.step == 4 && stage == "encoding" {
                self.controller.exporter.cancel(self.call("cancel", options: ["taskId": "task-4"]))
                self.controller.exporter.exportPDF(self.call("exportPDF", options: self.options("encode-concurrent"), failure: { error in
                    self.require(error.code == "EXPORT_BUSY", "encoder did not retain busy slot")
                    self.encodingBusyRejected = true
                }))
            }
            if self.step == 5 && stage == "saving" {
                self.controller.exporter.cancel(self.call("cancel", options: ["taskId": "task-5"]))
            }
        }))
        runNext()
    }

    private func runNext() {
        resolved = false
        stages = []
        let id = "task-\(step)"
        let export = call(step == 2 ? "exportPDF" : "exportLongImage", options: options(id, tall: step == 0 || step == 3), success: { value in
            self.require(!self.resolved, "double completion")
            self.resolved = true
            self.require(value["status"] as? String == (self.step == 2 ? "saved" : "cancelled"), "terminal status")
            self.require(self.temporaryExports() == self.initialFiles, "temporary export leaked")
            self.require(self.step != 0 || self.busyRejected, "concurrent call was not rejected")
            self.require(self.step != 4 || self.encodingBusyRejected, "encoder cancellation admitted concurrent task")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                if self.step == 5 {
                    print("VIEW_EXPORT_BRIDGE_PASSED"); fflush(stdout); exit(0)
                }
                self.step += 1
                self.runNext()
            }
        })
        if step == 2 { controller.exporter.exportPDF(export) } else { controller.exporter.exportLongImage(export) }
        if step == 0 {
            controller.exporter.exportPDF(call("exportPDF", options: options("concurrent"), success: { _ in self.fail("concurrent accepted") }, failure: { error in
                self.require(error.code == "EXPORT_BUSY", "concurrency code")
                self.busyRejected = true
            }))
            controller.exporter.cancel(call("cancel", options: ["taskId": "unrelated"]))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.require(!self.resolved, "unrelated cancellation affected task")
                self.controller.exporter.cancel(self.call("cancel", options: ["taskId": id]))
            }
        } else if step == 3 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.controller.webView!.loadHTMLString("<html><body>new owner document</body></html>", baseURL: nil)
            }
        }
    }

    private func handlePicker() {
        require(!resolved, "export resolved before save picker completion")
        require(stages.contains("encoding") && stages.last == "saving", "save stage ordering")
        guard let picker = controller.presentedViewController as? UIDocumentPickerViewController else {
            fail("native document picker missing at step \(step): \(String(describing: controller.presentedViewController))"); return
        }
        if step == 1 {
            // Exercises the system picker's actual cancellation delegate.
            controller.exporter.documentPickerWasCancelled(picker)
        } else {
            // A provider-copy fixture: checks promise timing and cleanup, not the
            // Files application's UI or a third-party cloud provider's behavior.
            do {
                let name = temporaryExports().subtracting(initialFiles).first!
                let source = FileManager.default.temporaryDirectory.appendingPathComponent(name).appendingPathComponent("snapshot.pdf")
                let saved = FileManager.default.temporaryDirectory.appendingPathComponent("probe-saved.pdf")
                try FileManager.default.copyItem(at: source, to: saved)
                require((try Data(contentsOf: saved)).starts(with: Data("%PDF".utf8)), "provider copy is not PDF")
                controller.exporter.documentPicker(picker, didPickDocumentsAt: [saved])
                try FileManager.default.removeItem(at: saved)
            } catch { fail("provider fixture: \(error)") }
        }
    }

    private func temporaryExports() -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path))?.filter { $0.hasPrefix("yuri-view-export-") } ?? [])
    }
    private func require(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
    private func fail(_ message: String) { print("VIEW_EXPORT_BRIDGE_FAILED: \(message)"); fflush(stdout); exit(1) }
}
