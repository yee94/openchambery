package com.yee94.openchamber.lynx

import android.app.Activity

/**
 * Android host for the Lynx phone shell.
 *
 * Slice 1 lock: Mode A only. A single full-screen LynxView loads the bundle.
 * Chat is a Lynx push that hides the dock. Do not add a fifth Chat destination
 * or a Material bottom nav (that would double-paint chrome).
 *
 * Application id must stay `com.yee94.openchamber` / `.debug` when FCM lands
 * (`docs/lynx-pitfalls.md` §6). This file does not register push.
 *
 * Requires the official Lynx Android SDK before it can compile in Gradle.
 */
class OpenChamberLynxHostActivity : Activity() {
    private val decision = OpenChamberLynxEmbedding.resolve()

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        // LynxView view = OpenChamberLynxViewFactory.create(this, decision)
        // setContentView(view)
        check(decision.mode == LynxEmbeddingMode.A)
        check(decision.androidGlassDowngrade)
    }
}
