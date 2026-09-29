import UIKit
import WebKit

@main
class HistoryScrollApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let controller = UIViewController()
        let webView = WKWebView(frame: .zero)
        webView.isInspectable = true
        controller.view = webView
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        webView.load(URLRequest(url: URL(string: CommandLine.arguments[1])!))
        return true
    }
}
