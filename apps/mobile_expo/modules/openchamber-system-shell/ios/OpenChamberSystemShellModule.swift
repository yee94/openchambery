import ExpoModulesCore
import Foundation
import UIKit
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

public class OpenChamberSystemShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenChamberSystemShell")

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      return [
        "platform": "ios",
        "liveActivity": OpenChamberExpoLiveActivity.isSupported(),
        "shareAppGroup": OpenChamberExpoShareStore.appGroupAvailable(),
        "uiGlassEffect": NSClassFromString("UIGlassEffect") != nil,
        "uiTabBar": true,
        "nativeComposerTextView": true,
      ]
    }

    AsyncFunction("isLiveActivitySupported") { () -> [String: Any] in
      ["supported": OpenChamberExpoLiveActivity.isSupported()]
    }

    AsyncFunction("startLiveActivity") { (request: [String: Any]) -> [String: Any] in
      let parsed = try OpenChamberExpoLiveActivity.parse(request, requireStartedAt: true)
      if let activityId = try await OpenChamberExpoLiveActivity.start(parsed) {
        return ["activityId": activityId]
      }
      return [:]
    }

    AsyncFunction("updateLiveActivity") { (request: [String: Any]) in
      let parsed = try OpenChamberExpoLiveActivity.parse(request, requireStartedAt: false)
      try await OpenChamberExpoLiveActivity.update(parsed)
    }

    AsyncFunction("endLiveActivity") { (request: [String: Any]) in
      let parsed = try OpenChamberExpoLiveActivity.parse(request, requireStartedAt: false)
      try await OpenChamberExpoLiveActivity.end(parsed)
    }

    AsyncFunction("updateShareCatalog") { (entries: [[String: Any]]) in
      try OpenChamberExpoShareStore.updateCatalog(entries)
    }

    AsyncFunction("listPendingShares") { () -> [String: Any] in
      let envelopes = try OpenChamberExpoShareStore.pending()
      return ["envelopes": envelopes]
    }

    AsyncFunction("ackShare") { (operationID: String) in
      try OpenChamberExpoShareStore.acknowledge(operationID)
    }

    AsyncFunction("releaseShareFiles") { (operationID: String) in
      try OpenChamberExpoShareStore.release(operationID)
    }

    // Android-only drafts; iOS Share Extension commits envelopes with exact targets.
    AsyncFunction("listShareDrafts") { () -> [String: Any] in
      ["drafts": []]
    }

    AsyncFunction("cancelShareDraft") { (_: String) in
      // no-op on iOS
    }

    AsyncFunction("createVirtualAsset") { (assetId: String, mime: String) -> [String: Any] in
      let url = try OpenChamberExpoVirtualAsset.create(assetId: assetId, mime: mime)
      return ["assetId": assetId, "url": url]
    }

    AsyncFunction("appendVirtualAsset") { (assetId: String, chunkBase64: String) in
      try OpenChamberExpoVirtualAsset.append(assetId: assetId, base64: chunkBase64)
    }

    AsyncFunction("finishVirtualAsset") { (assetId: String) -> [String: Any] in
      let url = try OpenChamberExpoVirtualAsset.finish(assetId: assetId)
      return ["url": url]
    }

    AsyncFunction("cancelVirtualAsset") { (assetId: String) in
      try OpenChamberExpoVirtualAsset.cancel(assetId: assetId)
    }

    // UITextView IME field — glass chrome + autocomplete stay in RN.
    View(NativeComposerTextView.self) {
      Events(
        "onChangeText",
        "onFocus",
        "onBlur",
        "onSubmit",
        "onCollapsedHeightChange",
        "onContentSizeChange",
        "onSelectionChange"
      )

      Prop("value") { (view: NativeComposerTextView, value: String?) in
        view.setText(value)
      }

      Prop("placeholder") { (view: NativeComposerTextView, value: String?) in
        view.placeholderText = value ?? ""
      }

      Prop("editable") { (view: NativeComposerTextView, value: Bool?) in
        view.setEditable(value)
      }

      Prop("maxContentHeight") { (view: NativeComposerTextView, value: Double?) in
        if let value { view.maxContentHeight = CGFloat(value) }
      }

      Prop("collapsedLineHeight") { (view: NativeComposerTextView, value: Double?) in
        if let value { view.collapsedLineHeight = CGFloat(value) }
      }

      Prop("fontSize") { (view: NativeComposerTextView, value: Double?) in
        if let value { view.fontSizeValue = CGFloat(value) }
      }

      Prop("textColor") { (view: NativeComposerTextView, value: String?) in
        if let value, let color = Self.parseColor(value) {
          view.textColorValue = color
        }
      }

      Prop("placeholderTextColor") { (view: NativeComposerTextView, value: String?) in
        if let value, let color = Self.parseColor(value) {
          view.placeholderColorValue = color
        }
      }
    }
  }

  private static func parseColor(_ raw: String) -> UIColor? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasPrefix("#") {
      var hex = String(trimmed.dropFirst())
      if hex.count == 3 {
        hex = hex.map { "\($0)\($0)" }.joined()
      }
      guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else {
        return nil
      }
      let hasAlpha = hex.count == 8
      let a = hasAlpha ? CGFloat((value & 0xff000000) >> 24) / 255 : 1
      let r = CGFloat((value & 0xff0000) >> 16) / 255
      let g = CGFloat((value & 0x00ff00) >> 8) / 255
      let b = CGFloat(value & 0x0000ff) / 255
      return UIColor(red: r, green: g, blue: b, alpha: a)
    }
    // rgba(r,g,b,a) / rgb(r,g,b)
    if trimmed.hasPrefix("rgba(") || trimmed.hasPrefix("rgb(") {
      let inner = trimmed
        .replacingOccurrences(of: "rgba(", with: "")
        .replacingOccurrences(of: "rgb(", with: "")
        .replacingOccurrences(of: ")", with: "")
      let parts = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
      guard parts.count >= 3,
            let r = Double(parts[0]),
            let g = Double(parts[1]),
            let b = Double(parts[2]) else { return nil }
      let a = parts.count >= 4 ? (Double(parts[3]) ?? 1) : 1
      return UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }
    return nil
  }
}
