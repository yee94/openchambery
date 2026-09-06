package com.yee94.openchamber.lynx

object OpenChamberLynxViewFactory {
    const val BUNDLE_URL = "main.lynx.bundle"

    fun globalProps(decision: LynxEmbeddingDecision, locale: String = "en"): Map<String, Any> =
        mapOf(
            "embeddingMode" to decision.mode.name,
            "chromeOwner" to decision.chromeOwner.name,
            "platform" to "android",
            "themeId" to "flexoki-light",
            "locale" to locale,
        )
}
