package com.yee94.openchamber.lynx

import android.content.Context
import com.lynx.tasm.provider.AbsTemplateProvider
import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * Loads embedded Lynx bundles from APK assets (e.g. `main.lynx.bundle`).
 */
class OpenChamberLynxTemplateProvider(
    context: Context,
) : AbsTemplateProvider() {
    private val appContext = context.applicationContext

    override fun loadTemplate(uri: String, callback: Callback) {
        Thread {
            try {
                appContext.assets.open(uri).use { input ->
                    val out = ByteArrayOutputStream()
                    val buffer = ByteArray(1024)
                    var length: Int
                    while (input.read(buffer).also { length = it } != -1) {
                        out.write(buffer, 0, length)
                    }
                    callback.onSuccess(out.toByteArray())
                }
            } catch (e: IOException) {
                callback.onFailed(e.message ?: "failed to load template: $uri")
            }
        }.start()
    }
}
