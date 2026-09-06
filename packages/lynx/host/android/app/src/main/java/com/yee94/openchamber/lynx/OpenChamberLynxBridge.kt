package com.yee94.openchamber.lynx

/** Mirrors packages/lynx/src/host/bridge.ts — native never owns the Lynx stack. */
sealed class LynxHostBridgeEvent {
    data class TabSelected(val tab: String) : LynxHostBridgeEvent()
    data class BackProgress(val progress: Double) : LynxHostBridgeEvent()
    object BackCommit : LynxHostBridgeEvent()
    object BackCancel : LynxHostBridgeEvent()
    data class KeyboardInset(val height: Double) : LynxHostBridgeEvent()
    data class ImeInset(
        val keyboardHeight: Double,
        val safeAreaBottom: Double,
        val collapsedComposerHeight: Double,
    ) : LynxHostBridgeEvent()
    data class PredictiveBackProgress(val progress: Double) : LynxHostBridgeEvent()
    object PredictiveBackCommit : LynxHostBridgeEvent()
    object PredictiveBackCancel : LynxHostBridgeEvent()
    data class QrScanResult(val rawValue: String) : LynxHostBridgeEvent()
    object QrScanCancelled : LynxHostBridgeEvent()
    data class QrScanFailed(val error: String) : LynxHostBridgeEvent()
    data class OAuthCallback(val callbackUrl: String) : LynxHostBridgeEvent()
    object OAuthCancelled : LynxHostBridgeEvent()
}

sealed class LynxPageToHostCommand {
    data class SetActiveTab(val tab: String) : LynxPageToHostCommand()
    object HideHostTabChrome : LynxPageToHostCommand()
    object ShowHostTabChrome : LynxPageToHostCommand()
    data class ReportOccupancy(val collapsedComposerHeight: Double) : LynxPageToHostCommand()
    object OpenInstances : LynxPageToHostCommand()
    object ScanPairingQr : LynxPageToHostCommand()
    data class OpenOAuthAuthorize(
        val url: String,
        val callbackScheme: String? = null,
        val prefersEphemeral: Boolean? = null,
    ) : LynxPageToHostCommand()
    object SubscribeImeInsets : LynxPageToHostCommand()
    object UnsubscribeImeInsets : LynxPageToHostCommand()
    object RegisterVirtualAssetScheme : LynxPageToHostCommand()
    data class SecureStore(
        val op: String,
        val prefixedKey: String,
        val data: String? = null,
        val access: Int? = null,
    ) : LynxPageToHostCommand()
}

fun interface LynxHostBridgeSink {
    fun emit(event: LynxHostBridgeEvent)
}

class OpenChamberLynxBridge(
    var camera: LynxCameraScanning = OpenChamberLynxCameraAdapter(),
    var oauthBrowser: LynxOAuthBrowsing = OpenChamberLynxOAuthBrowser(),
    var secureStore: LynxSecureStoring = OpenChamberLynxSecureStore(),
    var httpClient: LynxHttpClienting = OpenChamberLynxHttpClient(),
    var imeInset: LynxImeInsetPublishing = OpenChamberLynxImeInsetPublisher(),
    var virtualAssetHandler: LynxVirtualAssetHandling = OpenChamberLynxVirtualAssetHandler(),
) {
    var sink: LynxHostBridgeSink? = null

    fun emit(event: LynxHostBridgeEvent) {
        sink?.emit(event)
    }

    suspend fun dispatch(command: LynxPageToHostCommand) {
        when (command) {
            is LynxPageToHostCommand.ScanPairingQr -> {
                when (val result = camera.scanPairingQr()) {
                    is LynxCameraScanResult.Ok -> emit(LynxHostBridgeEvent.QrScanResult(result.rawValue))
                    LynxCameraScanResult.Cancelled -> emit(LynxHostBridgeEvent.QrScanCancelled)
                    LynxCameraScanResult.PermissionDenied ->
                        emit(LynxHostBridgeEvent.QrScanFailed("permission-denied"))
                    LynxCameraScanResult.Unavailable ->
                        emit(LynxHostBridgeEvent.QrScanFailed("unavailable"))
                    is LynxCameraScanResult.Failed ->
                        emit(LynxHostBridgeEvent.QrScanFailed(result.error))
                }
            }
            is LynxPageToHostCommand.OpenOAuthAuthorize -> {
                when (
                    val result = oauthBrowser.openAuthorize(
                        url = command.url,
                        callbackScheme = command.callbackScheme ?: "openchamber",
                        prefersEphemeral = command.prefersEphemeral ?: true,
                    )
                ) {
                    is LynxOAuthBrowserResult.Ok -> {
                        val callback = result.callbackUrl
                        if (callback != null) emit(LynxHostBridgeEvent.OAuthCallback(callback))
                        else emit(LynxHostBridgeEvent.OAuthCancelled)
                    }
                    LynxOAuthBrowserResult.Cancelled,
                    LynxOAuthBrowserResult.Unavailable,
                    is LynxOAuthBrowserResult.Failed,
                    -> emit(LynxHostBridgeEvent.OAuthCancelled)
                }
            }
            LynxPageToHostCommand.SubscribeImeInsets -> imeInset.start(this)
            LynxPageToHostCommand.UnsubscribeImeInsets -> imeInset.stop()
            LynxPageToHostCommand.RegisterVirtualAssetScheme ->
                virtualAssetHandler.registerSchemeHandler()
            else -> {
                // Host reacts once LynxView is linked.
            }
        }
    }
}
