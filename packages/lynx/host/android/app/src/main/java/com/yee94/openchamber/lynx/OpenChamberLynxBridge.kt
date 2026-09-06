package com.yee94.openchamber.lynx

/** Mirrors packages/lynx/src/host/bridge.ts — native never owns the Lynx stack. */
sealed class LynxHostBridgeEvent {
    data class TabSelected(val tab: String) : LynxHostBridgeEvent()
    data class BackProgress(val progress: Double) : LynxHostBridgeEvent()
    object BackCommit : LynxHostBridgeEvent()
    object BackCancel : LynxHostBridgeEvent()
    data class KeyboardInset(val height: Double) : LynxHostBridgeEvent()
    data class PredictiveBackProgress(val progress: Double) : LynxHostBridgeEvent()
    object PredictiveBackCommit : LynxHostBridgeEvent()
    object PredictiveBackCancel : LynxHostBridgeEvent()
}

sealed class LynxPageToHostCommand {
    data class SetActiveTab(val tab: String) : LynxPageToHostCommand()
    object HideHostTabChrome : LynxPageToHostCommand()
    object ShowHostTabChrome : LynxPageToHostCommand()
    data class ReportOccupancy(val collapsedComposerHeight: Double) : LynxPageToHostCommand()
    object OpenInstances : LynxPageToHostCommand()
}

class OpenChamberLynxBridge {
    fun dispatch(command: LynxPageToHostCommand) {
        // Host reacts once LynxView is linked.
        @Suppress("UNUSED_EXPRESSION")
        command
    }
}
