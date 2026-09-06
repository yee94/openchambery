package com.yee94.openchamber.lynx

/**
 * IME inset publisher — WindowInsetsCompat.Type.ime() → bridge keyboardInset.
 * Mirrors packages/lynx/src/host/imeInset.ts
 * Autocomplete/command list ABOVE glass composer — never inside glass content.
 */
data class LynxImeInsetSnapshot(
    val keyboardHeight: Double = 0.0,
    val safeAreaBottom: Double = 0.0,
    val collapsedComposerHeight: Double = 56.0,
)

interface LynxImeInsetPublishing {
    val snapshot: LynxImeInsetSnapshot
    fun start(bridge: OpenChamberLynxBridge)
    fun stop()
}

class OpenChamberLynxImeInsetPublisher : LynxImeInsetPublishing {
    override var snapshot: LynxImeInsetSnapshot = LynxImeInsetSnapshot()
        private set
    private var bridge: OpenChamberLynxBridge? = null

    override fun start(bridge: OpenChamberLynxBridge) {
        this.bridge = bridge
        // Inject point: ViewCompat.setOnApplyWindowInsetsListener + Type.ime()
    }

    override fun stop() {
        bridge = null
    }

    /** Host calls when WindowInsets change. */
    fun publish(keyboardHeight: Double, safeAreaBottom: Double = snapshot.safeAreaBottom) {
        snapshot = snapshot.copy(
            keyboardHeight = keyboardHeight,
            safeAreaBottom = safeAreaBottom,
        )
        bridge?.emit(LynxHostBridgeEvent.KeyboardInset(keyboardHeight))
        bridge?.emit(
            LynxHostBridgeEvent.ImeInset(
                keyboardHeight = keyboardHeight,
                safeAreaBottom = safeAreaBottom,
                collapsedComposerHeight = snapshot.collapsedComposerHeight,
            ),
        )
    }
}
