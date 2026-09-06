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

class OpenChamberLynxCameraAdapter : LynxCameraScanning {
    override suspend fun scanPairingQr(): LynxCameraScanResult = LynxCameraScanResult.Unavailable
}
