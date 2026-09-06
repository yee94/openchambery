import Foundation

/// Cap BarcodeScanner spirit for Lynx 扫一扫.
/// Without AVCaptureSession wiring this returns `.unavailable` — never fake a pairing payload.
/// Successful scans emit through OpenChamberLynxBridge → Lynx pairing parse.
enum OpenChamberLynxCameraScanResult {
  case ok(rawValue: String)
  case cancelled
  case permissionDenied
  case unavailable
  case failed(String)
}

protocol OpenChamberLynxCameraScanning {
  func scanPairingQr() async -> OpenChamberLynxCameraScanResult
}

/// Stub binder. Host replaces with AVCaptureMetadataOutput / Vision when shipping a device binary.
/// Callback path: scanPairingQr → Bridge.qrScanResult → Lynx `parseConnectionPayload`.
final class OpenChamberLynxCameraAdapter: OpenChamberLynxCameraScanning {
  /// Optional inject for tests / host camera module.
  var implementation: (() async -> OpenChamberLynxCameraScanResult)?

  func scanPairingQr() async -> OpenChamberLynxCameraScanResult {
    if let implementation {
      return await implementation()
    }
    // Inject point: present AVCaptureSession QR scanner; return .ok(rawValue: payload).
    return .unavailable
  }
}
