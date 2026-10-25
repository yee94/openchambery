import Capacitor
import Photos
import UIKit

@main
final class MediaSaveProbe: UIResponder, UIApplicationDelegate {
    private let plugin = YuriMediaPlugin()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        DispatchQueue.main.async {
            let source = Bundle.main.url(forResource: "source", withExtension: "webp")!
            let bytes = try! Data(contentsOf: source)
            let call = CAPPluginCall(callbackId: "photo-regression", methodName: "saveImage", options: [
                "dataBase64": bytes.base64EncodedString(), "mimeType": "image/webp", "filename": "sample.webp",
            ], success: { _, _ in
                print("PHOTO_SAVE_PASSED"); fflush(stdout); exit(0)
            }, error: { error in
                print("PHOTO_SAVE_FAILED: \(String(describing: error))"); fflush(stdout); exit(1)
            })!
            self.plugin.saveImage(call)
        }
        return true
    }
}
