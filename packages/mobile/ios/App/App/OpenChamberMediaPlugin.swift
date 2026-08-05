import Capacitor
import Photos
import UIKit

/**
 * Saves image bytes into the system photo library. Used by chat image long-press
 * "Save to Photos" so the WebView does not rely on navigator.share.
 */
@objc(OpenChamberMediaPlugin)
class OpenChamberMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberMediaPlugin"
    let jsName = "OpenChamberMedia"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise),
    ]

    private let maxBytes = 32 * 1024 * 1024

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
