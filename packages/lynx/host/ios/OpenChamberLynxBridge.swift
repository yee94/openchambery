import Foundation

/// Page ↔ host channel. Mirrors `packages/lynx/src/host/bridge.ts`.
/// Native never owns the Lynx route stack — tab taps emit events; Lynx commits.
enum OpenChamberLynxBridgeEvent {
  case tabSelected(String)
  case backProgress(Double)
  case backCommit
  case backCancel
  case keyboardInset(Double)
  case imeInset(keyboardHeight: Double, safeAreaBottom: Double, collapsedComposerHeight: Double)
  case predictiveBackProgress(Double)
  case predictiveBackCommit
  case predictiveBackCancel
  case qrScanResult(rawValue: String)
  case qrScanCancelled
  case qrScanFailed(String)
  case oauthCallback(callbackUrl: String)
  case oauthCancelled
}

enum OpenChamberLynxPageCommand {
  case setActiveTab(String)
  case hideHostTabChrome
  case showHostTabChrome
  case reportOccupancy(collapsedComposerHeight: Double)
  case openInstances
  case scanPairingQr
  case openOAuthAuthorize(url: String, callbackScheme: String?, prefersEphemeral: Bool?)
  case subscribeImeInsets
  case unsubscribeImeInsets
  case registerVirtualAssetScheme
  case secureStore(op: String, prefixedKey: String, data: String?, access: Int?)
}

protocol OpenChamberLynxBridgeSink: AnyObject {
  func emit(_ event: OpenChamberLynxBridgeEvent)
}

/// Host-side dispatcher. Wire LynxView NativeModules / CustomEvent here once SDK links.
final class OpenChamberLynxBridge {
  weak var sink: OpenChamberLynxBridgeSink?
  var camera: OpenChamberLynxCameraScanning = OpenChamberLynxCameraAdapter()
  var oauthBrowser: OpenChamberLynxOAuthBrowsing = OpenChamberLynxOAuthBrowser()
  var secureStore: OpenChamberLynxSecureStoring = OpenChamberLynxSecureStore()
  var httpClient: OpenChamberLynxHttpClienting = OpenChamberLynxHttpClient()
  var imeInset: OpenChamberLynxImeInsetPublishing = OpenChamberLynxImeInsetPublisher()
  var virtualAssetHandler: OpenChamberLynxVirtualAssetHandling = OpenChamberLynxVirtualAssetHandler()

  func dispatch(_ command: OpenChamberLynxPageCommand) {
    switch command {
    case .scanPairingQr:
      Task { @MainActor in
        let result = await camera.scanPairingQr()
        switch result {
        case .ok(let raw):
          emit(.qrScanResult(rawValue: raw))
        case .cancelled:
          emit(.qrScanCancelled)
        case .permissionDenied:
          emit(.qrScanFailed("permission-denied"))
        case .unavailable:
          emit(.qrScanFailed("unavailable"))
        case .failed(let message):
          emit(.qrScanFailed(message))
        }
      }
    case .openOAuthAuthorize(let urlString, let scheme, let ephemeral):
      Task { @MainActor in
        guard let url = URL(string: urlString) else {
          emit(.oauthCancelled)
          return
        }
        let result = await oauthBrowser.openAuthorize(
          url: url,
          callbackScheme: scheme ?? "openchamber",
          prefersEphemeral: ephemeral ?? true
        )
        switch result {
        case .ok(let callbackUrl):
          if let callbackUrl {
            emit(.oauthCallback(callbackUrl: callbackUrl.absoluteString))
          } else {
            emit(.oauthCancelled)
          }
        case .cancelled, .unavailable:
          emit(.oauthCancelled)
        case .failed:
          emit(.oauthCancelled)
        }
      }
    case .subscribeImeInsets:
      imeInset.start(emittingTo: self)
    case .unsubscribeImeInsets:
      imeInset.stop()
    case .registerVirtualAssetScheme:
      _ = virtualAssetHandler.registerSchemeHandler()
    case .secureStore, .setActiveTab, .hideHostTabChrome, .showHostTabChrome,
         .reportOccupancy, .openInstances:
      // Host reacts (hide tab chrome, Keychain, etc.) once LynxView is linked.
      break
    }
  }

  func emit(_ event: OpenChamberLynxBridgeEvent) {
    sink?.emit(event)
  }
}
