package com.yee94.openchamber.lynx

import android.content.Context
import android.util.Log
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
                    val bytes = out.toByteArray()
                    Log.i(TAG, "assets_open_ok uri=$uri bytes=${bytes.size}")
                    callback.onSuccess(bytes)
                }
            } catch (e: IOException) {
                val msg = e.message ?: "failed to load template: $uri"
                Log.e(TAG, "assets_open_failure uri=$uri err=$msg", e)
                callback.onFailed(msg)
            }
        }.start()
    }

    companion object {
        private const val TAG = "OpenChamberLynx"
    }
}
