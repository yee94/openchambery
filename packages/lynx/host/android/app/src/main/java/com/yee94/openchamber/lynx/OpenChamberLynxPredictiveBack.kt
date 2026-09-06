package com.yee94.openchamber.lynx

/**
 * Predictive Back (API 34+) / edge-back contract.
 * One owner with Lynx gesture arena — see packages/lynx/src/host/predictiveBack.ts.
 */
enum class LynxPredictiveBackOwner { HOST, LYNX }

data class LynxPredictiveBackPolicy(
    val owner: LynxPredictiveBackOwner,
    val edgeWidthDp: Float = 28f,
)

object OpenChamberLynxPredictiveBack {
    fun resolve(
        secondaryVisible: Boolean,
        composerSessionSwipeActive: Boolean,
    ): LynxPredictiveBackPolicy {
        if (composerSessionSwipeActive) {
            return LynxPredictiveBackPolicy(LynxPredictiveBackOwner.LYNX)
        }
        return LynxPredictiveBackPolicy(LynxPredictiveBackOwner.HOST)
    }
}
