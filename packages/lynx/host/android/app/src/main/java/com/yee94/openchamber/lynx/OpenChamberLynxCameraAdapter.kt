package com.yee94.openchamber.lynx

/** Cap BarcodeScanner spirit — without CameraX this is unavailable (never fake pairing). */
sealed class LynxCameraScanResult {
    data class Ok(val rawValue: String) : LynxCameraScanResult()
    object Cancelled : LynxCameraScanResult()
    object PermissionDenied : LynxCameraScanResult()
    object Unavailable : LynxCameraScanResult()
    data class Failed(val error: String) : LynxCameraScanResult()
}

interface LynxCameraScanning {
    suspend fun scanPairingQr(): LynxCameraScanResult
}

/**
 * Stub binder. Host replaces with CameraX / ML Kit barcode when shipping a device binary.
 * Callback path: scanPairingQr → Bridge.QrScanResult → Lynx parseConnectionPayload.
 */
class OpenChamberLynxCameraAdapter(
    private val implementation: (suspend () -> LynxCameraScanResult)? = null,
) : LynxCameraScanning {
    override suspend fun scanPairingQr(): LynxCameraScanResult {
        if (implementation != null) return implementation.invoke()
        // Inject point: CameraX analyzer → return Ok(rawValue = payload)
        return LynxCameraScanResult.Unavailable
    }
}
