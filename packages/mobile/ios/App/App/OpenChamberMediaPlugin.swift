import Capacitor
import ImageIO
import Photos
import UIKit
import UniformTypeIdentifiers

/**
 * Native media/file writes so the WebView does not rely on navigator.share:
 * saveImage writes to Photos; saveFile presents the system document picker.
 * transcode converts HEIC/HEIF bytes to JPEG via ImageIO off the main thread.
 */
@objc(OpenChamberMediaPlugin)
class OpenChamberMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberMediaPlugin"
    let jsName = "OpenChamberMedia"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcode", returnType: CAPPluginReturnPromise),
    ]

    private let maxBytes = 32 * 1024 * 1024
    private let transcodeQueue = DispatchQueue(label: "com.openchamber.media.transcode", qos: .userInitiated)
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

    @objc func transcode(_ call: CAPPluginCall) {
        guard var dataBase64 = call.getString("data"), !dataBase64.isEmpty else {
            call.reject("data is required")
            return
        }
        if dataBase64.lowercased().hasPrefix("data:"), let comma = dataBase64.firstIndex(of: ",") {
            dataBase64 = String(dataBase64[dataBase64.index(after: comma)...])
        }
        guard let mime = call.getString("mime")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !mime.isEmpty else {
            call.reject("mime is required")
            return
        }
        let quality = Self.clampJpegQuality(call.getDouble("quality"))
        // ImageIO decode/encode is CPU-bound; keep it off the Capacitor/main thread.
        transcodeQueue.async { [weak self] in
            guard let self else {
                call.reject("Plugin deallocated")
                return
            }
            do {
                let jpeg = try self.transcodeHeicToJpeg(dataBase64: dataBase64, mime: mime, quality: quality)
                call.resolve(["data": jpeg.base64EncodedString(), "mime": "image/jpeg"])
            } catch {
                call.reject(error.localizedDescription)
            }
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

    private static func clampJpegQuality(_ raw: Double?) -> CGFloat {
        let value = raw ?? 0.9
        if value.isNaN || value.isInfinite { return 0.9 }
        return CGFloat(min(max(value, 0.0), 1.0))
    }

    private func transcodeHeicToJpeg(dataBase64: String, mime: String, quality: CGFloat) throws -> Data {
        guard mime == "image/heic" || mime == "image/heif" else {
            throw ImageTranscodeError.unsupportedMime(mime)
        }
        guard let input = Data(base64Encoded: dataBase64, options: [.ignoreUnknownCharacters]), !input.isEmpty else {
            throw ImageTranscodeError.invalidBase64
        }
        guard input.count <= maxBytes else {
            throw ImageTranscodeError.tooLarge
        }

        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(input as CFData, sourceOptions) else {
            throw ImageTranscodeError.decodeFailed
        }
        guard let uti = CGImageSourceGetType(source) as String? else {
            throw ImageTranscodeError.notAnImage
        }
        let isHeif = UTType(uti)?.conforms(to: .heif) == true
            || uti.caseInsensitiveCompare(UTType.heic.identifier) == .orderedSame
            || uti.caseInsensitiveCompare("public.heif") == .orderedSame
            || uti.caseInsensitiveCompare("public.heic") == .orderedSame
        guard isHeif else {
            throw ImageTranscodeError.notHeic(uti)
        }
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, sourceOptions) else {
            throw ImageTranscodeError.decodeFailed
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ImageTranscodeError.encodeFailed
        }
        let destOptions = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(destination, image, destOptions)
        guard CGImageDestinationFinalize(destination) else {
            throw ImageTranscodeError.encodeFailed
        }
        guard output.length > 0 else {
            throw ImageTranscodeError.encodeFailed
        }
        return output as Data
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

private enum ImageTranscodeError: LocalizedError {
    case unsupportedMime(String)
    case invalidBase64
    case tooLarge
    case notAnImage
    case notHeic(String)
    case decodeFailed
    case encodeFailed

    var errorDescription: String? {
        switch self {
        case .unsupportedMime(let mime):
            return "Unsupported image type: \(mime)"
        case .invalidBase64:
            return "Image data is empty or invalid base64"
        case .tooLarge:
            return "Image exceeds maximum size"
        case .notAnImage:
            return "Input is not a decodable image"
        case .notHeic(let uti):
            return "Input is not HEIC/HEIF (detected \(uti))"
        case .decodeFailed:
            return "Could not decode HEIC/HEIF image"
        case .encodeFailed:
            return "Could not encode JPEG"
        }
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
