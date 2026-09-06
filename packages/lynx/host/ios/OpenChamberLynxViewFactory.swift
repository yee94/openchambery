import Foundation

/// Builds a host `LynxView` once CocoaPods `Lynx` / `XElement` are linked.
///
/// Global props must include the embedding decision so the Lynx page does not
/// paint a second dock in Mode B. Full-page auto glass skin is Mode A only.
enum OpenChamberLynxViewFactory {
  static func globalProps(
    tabId: String,
    decision: OpenChamberLynxEmbeddingDecision,
    themeId: String = "flexoki-light",
    locale: String = "en"
  ) -> [String: Any] {
    [
      "embeddingMode": decision.mode.rawValue,
      "chromeOwner": decision.chromeOwner.rawValue,
      "platform": "ios",
      "tabId": tabId,
      "themeId": themeId,
      "locale": locale,
    ]
  }

  /// Template URL for the rspeedy bundle (`main.lynx.bundle`) when that job lands.
  static let bundleURL = "main.lynx.bundle"
}
