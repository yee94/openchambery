import Capacitor
import UIKit

/// Shared impact generators for the Capacitor bridge and native UI controls.
enum OpenChamberHapticFeedback {
    private static var lightGenerator: UIImpactFeedbackGenerator?
    private static var mediumGenerator: UIImpactFeedbackGenerator?
    private static var heavyGenerator: UIImpactFeedbackGenerator?

    static func impact(style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let run = {
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

        if Thread.isMainThread {
            run()
        } else {
            DispatchQueue.main.async(execute: run)
        }
    }

    /// Matches shared UI button taps (`triggerMobileHaptic('light')`).
    static func impactLight() {
        impact(style: .light)
    }
}

@objc(OpenChamberHapticsPlugin)
class OpenChamberHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberHapticsPlugin"
    let jsName = "OpenChamberHaptics"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "impactLight", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "impactMedium", returnType: CAPPluginReturnNone),
        CAPPluginMethod(name: "impactHeavy", returnType: CAPPluginReturnNone),
    ]

    @objc func impactLight(_ call: CAPPluginCall) {
        // CAPPluginCall is intentionally left unresolved so this stays fire-and-forget.
        DispatchQueue.main.async {
            OpenChamberHapticFeedback.impact(style: .light)
        }
    }

    @objc func impactMedium(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            OpenChamberHapticFeedback.impact(style: .medium)
        }
    }

    @objc func impactHeavy(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            OpenChamberHapticFeedback.impact(style: .heavy)
        }
    }
}
