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
  }
}
