import Capacitor
import Photos
import UIKit

/**
 * Native media/file writes so the WebView does not rely on navigator.share:
 * saveImage writes to Photos; saveFile presents the system document picker.
 */
@objc(OpenChamberMediaPlugin)
class OpenChamberMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberMediaPlugin"
    let jsName = "OpenChamberMedia"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise),
    ]

    private let maxBytes = 32 * 1024 * 1024
    private var saveFileDelegate: SaveFilePickerDelegate?

    @objc func saveImage(_ call: CAPPluginCall) {
        guard var dataBase64 = call.getString("dataBase64"), !dataBase64.isEmpty else {
            call.reject("dataBase64 is required")
            return
        }
        if dataBase64.lowercased().hasPrefix("data:"), let comma = dataBase64.firstIndex(of: ",") {
            dataBase64 = String(dataBase64[dataBase64.index(after: comma)...])
        }

        guard let data = Data(base64Encoded: dataBase64, options: [.ignoreUnknownCharacters]), !data.isEmpty else {
            call.reject("Image data is empty or invalid base64")
            return
        }
        guard data.count <= maxBytes else {
            call.reject("Image exceeds maximum size")
            return
        }
        guard let image = UIImage(data: data) else {
            call.reject("Could not decode image")
            return
        }

        ensureAddOnlyAuthorization { [weak self] granted, errorMessage in
            guard let self else { return }
            if !granted {
                call.reject(errorMessage ?? "Photo library permission denied")
                return
            }
            self.performSave(image: image, call: call)
        }
    }

    private func ensureAddOnlyAuthorization(completion: @escaping (Bool, String?) -> Void) {
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        switch status {
        case .authorized, .limited:
            completion(true, nil)
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { next in
                DispatchQueue.main.async {
                    completion(next == .authorized || next == .limited, next == .denied || next == .restricted
                        ? "Photo library permission denied"
                        : nil)
                }
            }
        case .denied, .restricted:
            completion(false, "Photo library permission denied")
        @unknown default:
            completion(false, "Photo library permission unavailable")
        }
    }

    @objc func saveFile(_ call: CAPPluginCall) {
        guard var dataBase64 = call.getString("dataBase64"), !dataBase64.isEmpty else {
            call.reject("dataBase64 is required")
            return
        }
        if dataBase64.lowercased().hasPrefix("data:"), let comma = dataBase64.firstIndex(of: ",") {
            dataBase64 = String(dataBase64[dataBase64.index(after: comma)...])
        }

        guard let data = Data(base64Encoded: dataBase64, options: [.ignoreUnknownCharacters]), !data.isEmpty else {
            call.reject("File data is empty or invalid base64")
            return
        }
        guard data.count <= maxBytes else {
            call.reject("File exceeds maximum size")
            return
        }

        let filename = Self.sanitizeFilename(call.getString("filename") ?? "export.json")
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do {
            try data.write(to: tempURL, options: .atomic)
        } catch {
            call.reject(error.localizedDescription)
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let presenter = self.bridge?.viewController else {
                try? FileManager.default.removeItem(at: tempURL)
                call.reject("No view controller to present the save picker")
                return
            }

            let picker = UIDocumentPickerViewController(forExporting: [tempURL], asCopy: true)
            picker.shouldShowFileExtensions = true
            let delegate = SaveFilePickerDelegate { [weak self] saved in
                try? FileManager.default.removeItem(at: tempURL)
                self?.saveFileDelegate = nil
                call.resolve(["cancelled": !saved])
            }
            self.saveFileDelegate = delegate
            picker.delegate = delegate
            presenter.present(picker, animated: true)
        }
    }

    private static func sanitizeFilename(_ raw: String) -> String {
        let base = (raw as NSString).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleaned = base.replacingOccurrences(of: "[^A-Za-z0-9._\\- ()\\[\\]]+", with: "_", options: .regularExpression)
        if cleaned.isEmpty { return "export.json" }
        if cleaned.range(of: "\\.[A-Za-z0-9]{1,8}$", options: .regularExpression) == nil {
            return cleaned + ".json"
        }
        return cleaned
    }

    private func performSave(image: UIImage, call: CAPPluginCall) {
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.creationRequestForAsset(from: image)
        }, completionHandler: { success, error in
            DispatchQueue.main.async {
                if success {
                    call.resolve()
                } else {
                    call.reject(error?.localizedDescription ?? "Could not save image to Photos")
                }
            }
        })
    }
}

private final class SaveFilePickerDelegate: NSObject, UIDocumentPickerDelegate {
    private let finish: (Bool) -> Void

    init(finish: @escaping (Bool) -> Void) {
        self.finish = finish
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(false)
    }
}
