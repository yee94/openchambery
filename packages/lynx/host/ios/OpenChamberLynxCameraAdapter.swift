import Foundation

/// Cap BarcodeScanner spirit for Lynx 扫一扫.
/// Without AVCaptureSession wiring this returns `.unavailable` — never fake a pairing payload.
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

/// Stub binder. Host replaces with real camera when shipping a device binary.
final class OpenChamberLynxCameraAdapter: OpenChamberLynxCameraScanning {
  func scanPairingQr() async -> OpenChamberLynxCameraScanResult {
    .unavailable
  }
}
