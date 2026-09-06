package com.yee94.openchamber.lynx

import android.app.Activity
import android.os.Bundle
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.xelement.XElementBehaviors

/**
 * Android host for the Lynx phone shell.
 *
 * Slice 1 lock: Mode A only. A single full-screen LynxView loads the bundle.
 * Chat is a Lynx push that hides the dock. Do not add a fifth Chat destination
 * or a Material bottom nav (that would double-paint chrome).
 *
 * Sideload applicationId is `com.yee94.openchamber.lynx.debug` so this APK
 * installs beside Cap/Flutter/Expo (`com.yee94.openchamber(.debug)`). FCM will
 * not work until a matching Firebase Android app is added
 * (`docs/lynx-pitfalls.md` §6). This file does not register push.
 */
class OpenChamberLynxHostActivity : Activity() {
    private val decision = OpenChamberLynxEmbedding.resolve()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        check(decision.mode == LynxEmbeddingMode.A)
        check(decision.androidGlassDowngrade)

        val lynxView = buildLynxView()
        setContentView(lynxView)
        lynxView.renderTemplateUrl(OpenChamberLynxViewFactory.BUNDLE_URL, "")
    }

    private fun buildLynxView(): LynxView {
        val viewBuilder = LynxViewBuilder()
        viewBuilder.addBehaviors(XElementBehaviors().create())
        viewBuilder.setTemplateProvider(OpenChamberLynxTemplateProvider(this))
        return viewBuilder.build(this)
    }
}
