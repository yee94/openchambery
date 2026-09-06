import UIKit

/// Predictive / edge-back contract. One owner with Lynx gesture arena.
/// Mirrors `packages/lynx/src/host/predictiveBack.ts`.
///
/// Host binds UIScreenEdgePanGestureRecognizer (or iOS 26 interactive back)
/// and feeds progress / commit / cancel into `OpenChamberLynxBridge`.
enum OpenChamberLynxPredictiveBackOwner: String {
  case host
  case lynx
}

struct OpenChamberLynxPredictiveBackPolicy {
  /// When Lynx secondary is visible, host owns the edge unless Lynx claims composer swipe.
  let owner: OpenChamberLynxPredictiveBackOwner
  let edgeWidthPoints: CGFloat
}

enum OpenChamberLynxPredictiveBack {
  static let defaultEdgeWidth: CGFloat = 28

  static func resolve(
    secondaryVisible: Bool,
    composerSessionSwipeActive: Bool
  ) -> OpenChamberLynxPredictiveBackPolicy {
    if composerSessionSwipeActive {
      return OpenChamberLynxPredictiveBackPolicy(owner: .lynx, edgeWidthPoints: defaultEdgeWidth)
    }
    if secondaryVisible {
      return OpenChamberLynxPredictiveBackPolicy(owner: .host, edgeWidthPoints: defaultEdgeWidth)
    }
    return OpenChamberLynxPredictiveBackPolicy(owner: .host, edgeWidthPoints: defaultEdgeWidth)
  }
}
