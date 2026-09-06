package com.yee94.openchamber.lynx

/**
 * Bundle URL + global-props for the Mode A full-screen LynxView.
 *
 * Props must reach JS `createHostGlobalProps` / `lynx.__globalProps` so App
 * boots ConnectWelcome splash (not an empty transparent page on black).
 * Safe-area keys are stubs until ImeInset / WindowInsets publish live values.
 */
object OpenChamberLynxViewFactory {
    const val BUNDLE_URL = "main.lynx.bundle"

    fun globalProps(decision: LynxEmbeddingDecision, locale: String = "en"): Map<String, Any> =
        mapOf(
            "embeddingMode" to decision.mode.name,
            "chromeOwner" to decision.chromeOwner.name,
            "platform" to "android",
            "themeId" to "flexoki-light",
            "locale" to locale,
            // Safe-area stubs (px). Host ImeInset / WindowInsets replace these on 真机.
            "safeAreaTop" to 0,
            "safeAreaBottom" to 0,
            "safeAreaLeft" to 0,
            "safeAreaRight" to 0,
        )
}
