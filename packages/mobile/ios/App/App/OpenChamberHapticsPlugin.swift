import Capacitor
import UIKit

@objc(OpenChamberHapticsPlugin)
class OpenChamberHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberHapticsPlugin"
    let jsName = "OpenChamberHaptics"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "impactLight", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "impactMedium", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "impactHeavy", returnType: CAPPluginReturnNone),
    ]

    private var lightGenerator: UIImpactFeedbackGenerator?
    private var mediumGenerator: UIImpactFeedbackGenerator?
    private var heavyGenerator: UIImpactFeedbackGenerator?

    @objc func impactLight(_ call: CAPPluginCall) {
        // CAPPluginCall is intentionally left unresolved so this stays fire-and-forget.
        DispatchQueue.main.async { [weak self] in
            self?.impact(style: .light)
        }
    }

    @objc func impactMedium(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.impact(style: .medium)
        }
    }

    @objc func impactHeavy(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.impact(style: .heavy)
        }
    }

    private func impact(style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let generator: UIImpactFeedbackGenerator
        switch style {
        case .medium:
            if let existing = mediumGenerator {
                generator = existing
            } else {
                generator = UIImpactFeedbackGenerator(style: .medium)
                generator.prepare()
                mediumGenerator = generator
            }
        case .heavy:
            if let existing = heavyGenerator {
                generator = existing
            } else {
                generator = UIImpactFeedbackGenerator(style: .heavy)
                generator.prepare()
                heavyGenerator = generator
            }
        default:
            if let existing = lightGenerator {
                generator = existing
            } else {
                generator = UIImpactFeedbackGenerator(style: .light)
                generator.prepare()
                lightGenerator = generator
            }
        }

        generator.impactOccurred()
        generator.prepare()
    }
}
