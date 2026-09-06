import Foundation

/// Page ↔ host channel. Mirrors `packages/lynx/src/host/bridge.ts`.
/// Native never owns the Lynx route stack — tab taps emit events; Lynx commits.
enum OpenChamberLynxBridgeEvent {
  case tabSelected(String)
  case backProgress(Double)
  case backCommit
  case backCancel
  case keyboardInset(Double)
  case predictiveBackProgress(Double)
  case predictiveBackCommit
  case predictiveBackCancel
}

enum OpenChamberLynxPageCommand {
  case setActiveTab(String)
  case hideHostTabChrome
  case showHostTabChrome
  case reportOccupancy(collapsedComposerHeight: Double)
  case openInstances
}

protocol OpenChamberLynxBridgeSink: AnyObject {
  func emit(_ event: OpenChamberLynxBridgeEvent)
}

/// Host-side dispatcher. Wire LynxView NativeModules / CustomEvent here once SDK links.
final class OpenChamberLynxBridge {
  weak var sink: OpenChamberLynxBridgeSink?

  func dispatch(_ command: OpenChamberLynxPageCommand) {
    // Host reacts (hide tab chrome, open instances chrome, etc.).
    // Intentionally no-op until Lynx SDK is linked — keeps compile surface honest.
    _ = command
  }

  func emit(_ event: OpenChamberLynxBridgeEvent) {
    sink?.emit(event)
  }
}
