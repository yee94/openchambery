package com.yee94.openchamber.lynx

/**
 * Mirrors `packages/lynx/src/host/embedding.ts`.
 *
 * Android slice 1 is Mode A: Lynx owns the four-tab dock and uses
 * `<blur-view blur-radius>` — not a fake `UIGlassEffect`.
 * Do not install a Material `NavigationBar` beside the Lynx dock.
 */
enum class LynxEmbeddingMode { A, B }

enum class LynxChromeOwner { lynx, host }

data class LynxEmbeddingDecision(
    val mode: LynxEmbeddingMode,
    val chromeOwner: LynxChromeOwner,
    val paintsLynxDock: Boolean,
    val fullPageAutoGlassSkin: Boolean,
    val androidGlassDowngrade: Boolean,
)

object OpenChamberLynxEmbedding {
    fun resolve(): LynxEmbeddingDecision =
        LynxEmbeddingDecision(
            mode = LynxEmbeddingMode.A,
            chromeOwner = LynxChromeOwner.lynx,
            paintsLynxDock = true,
            fullPageAutoGlassSkin = true,
            androidGlassDowngrade = true,
        )

    fun shouldPaintLynxDock(secondaryVisible: Boolean, overlayActive: Boolean): Boolean =
        !secondaryVisible && !overlayActive
}
