import Capacitor
import UIKit

@objc(OpenChamberPhysicalScalePlugin)
class OpenChamberPhysicalScalePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OpenChamberPhysicalScalePlugin"
    let jsName = "OpenChamberPhysicalScale"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getMetrics", returnType: CAPPluginReturnPromise),
    ]

    @objc func getMetrics(_ call: CAPPluginCall) {
        // 1 CSS px = 1 UIKit pt ≈ 1/163 in. Web scale stays 1.
        call.resolve([
            "xdpi": 163.0,
            "ydpi": 163.0,
            "density": 1.0,
            "densityDpi": 163,
            "stableDensityDpi": 163,
        ])
    }
}
