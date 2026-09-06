import UIKit

/// Mirrors `packages/lynx/src/host/embedding.ts`.
/// iOS 26+ with a real tab bar → Mode B. Older iOS → Mode A.
/// Mode C (Capacitor hybrid overlay) is forbidden.
enum OpenChamberLynxEmbeddingMode: String {
  case fullPageLynx = "A"
  case hostChrome = "B"
}

enum OpenChamberLynxChromeOwner: String {
  case lynx
  case host
}

struct OpenChamberLynxEmbeddingDecision {
  let mode: OpenChamberLynxEmbeddingMode
  let chromeOwner: OpenChamberLynxChromeOwner
  let paintsLynxDock: Bool
  let fullPageAutoGlassSkin: Bool
}

enum OpenChamberLynxEmbedding {
  static let liquidGlassTabBarMajor = 26

  static func resolve(
    iosMajorVersion: Int = ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
    hostTabChromeAvailable: Bool = true
  ) -> OpenChamberLynxEmbeddingDecision {
    if hostTabChromeAvailable && iosMajorVersion >= liquidGlassTabBarMajor {
      return OpenChamberLynxEmbeddingDecision(
        mode: .hostChrome,
        chromeOwner: .host,
        paintsLynxDock: false,
        fullPageAutoGlassSkin: false
      )
    }
    return OpenChamberLynxEmbeddingDecision(
      mode: .fullPageLynx,
      chromeOwner: .lynx,
      paintsLynxDock: true,
      fullPageAutoGlassSkin: true
    )
  }

  static func shouldShowHostTabChrome(
    decision: OpenChamberLynxEmbeddingDecision,
    secondaryVisible: Bool,
    overlayActive: Bool
  ) -> Bool {
    guard decision.chromeOwner == .host else { return false }
    return !secondaryVisible && !overlayActive
  }
}
